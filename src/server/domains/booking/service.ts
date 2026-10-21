import { DateTime } from 'luxon';
import { sql } from 'kysely';
import { withSystem, withTenant, type Tx } from '../../db/client';
import { AppError, Errors } from '../../http/errors';
import { audit, type AuditActor } from '../../infra/audit';
import { idempotent, requestHash } from '../../infra/idempotency';
import { enqueue } from '../../infra/outbox';
import { nextReadableNumber } from '../../infra/counters';
import { notifyCapability, notifyStaff, notifyUsers } from '../../infra/notify';
import type { SessionUser } from '../../auth/service';
import { hasCapability, type TenantAccess } from '../../tenancy/access';
import { ensureTenantCustomerForUser } from '../customers/relationship';
import { itinerariesForDate, validateItinerary, type Itinerary } from './engine';
import { loadEngineInput, primaryBranch, resolveItems, type Audience, type RequestedItem, type ResolvedItem } from './loader';
import { cancellationRefund, computeTotals } from './pricing';
import { computePaymentTerms } from './terms';
import { ACTIVE_STATUSES, TRANSITIONS, type BookingAction, type BookingStatus } from './transitions';
import { bookingHooks } from './hooks';
import type { PaymentMethod } from '@/shared/payments';

const MIN = 60_000;

// ── Availability search ─────────────────────────────────────────────────────
export type SearchInput = { branchId?: string | null; items: RequestedItem[]; from: string; to: string; audience: Audience; now?: Date };

function serializeItinerary(it: Itinerary, resolved: ResolvedItem[]) {
  return {
    start: new Date(it.start).toISOString(),
    end: new Date(it.end).toISOString(),
    total_gap_min: it.totalGapMin,
    gaps_min: it.gapsMin,
    items: it.items.map((p) => {
      const r = resolved.find((x) => x.key === p.key)!;
      return {
        key: p.key, service_id: p.serviceId, staff_id: p.staffId, staff_name: r.staffTerms[p.staffId]!.name,
        start: new Date(p.start).toISOString(), end: new Date(p.end).toISOString(),
        price_minor: r.staffTerms[p.staffId]!.priceMinor, duration_min: r.staffTerms[p.staffId]!.durationMin,
      };
    }),
  };
}

/**
 * Feasible options only — never who is booked or why a time is taken.
 * Results are advisory; createHold re-validates inside its transaction.
 */
export async function searchAvailability(tenantId: string, input: SearchInput) {
  const from = DateTime.fromISO(input.from), to = DateTime.fromISO(input.to);
  if (!from.isValid || !to.isValid || to < from) throw Errors.invalid('invalid_range');
  if (to.diff(from, 'days').days > 14) throw Errors.invalid('range_too_long', 'Search at most 14 days at a time');
  return withTenant(tenantId, async (trx) => {
    const branchId = input.branchId ?? (await primaryBranch(trx, tenantId)).id;
    const resolved = await resolveItems(trx, tenantId, branchId, input.items, input.audience);
    const engine = await loadEngineInput(trx, tenantId, branchId, resolved, input.from, input.to, input.now);
    const days: Record<string, ReturnType<typeof serializeItinerary>[]> = {};
    for (let d = from; d <= to; d = d.plus({ days: 1 })) {
      const iso = d.toISODate()!;
      days[iso] = itinerariesForDate(engine, resolved.map((r) => r.spec), iso).map((it) => serializeItinerary(it, resolved));
    }
    const any = Object.values(days).some((x) => x.length);
    let nextAvailable: string | null = null;
    if (!any) {
      // Suggest the next day with availability (bounded look-ahead).
      const ahead = await loadEngineInput(trx, tenantId, branchId, resolved, to.plus({ days: 1 }).toISODate()!, to.plus({ days: 30 }).toISODate()!, input.now);
      for (let d = to.plus({ days: 1 }), i = 0; i < 30; d = d.plus({ days: 1 }), i++) {
        if (itinerariesForDate(ahead, resolved.map((r) => r.spec), d.toISODate()!, { maxItinerariesPerDay: 1, maxNodes: 5000 }).length) { nextAvailable = d.toISODate(); break; }
      }
    }
    return {
      branch_id: branchId, timezone: engine.tz, slot_increment_min: engine.slotIncrementMin, days,
      empty_reason: any ? null : (nextAvailable ? 'no_availability_in_range' : 'no_availability_soon'),
      next_available_date: nextAvailable,
      suggestion: !any && input.items.length > 1 ? 'try_separate_bookings_or_other_days' : null,
      items: resolved.map((r) => ({
        key: r.key, service_id: r.service.id, name_ar: r.service.name_ar, name_en: r.service.name_en,
        options: Object.entries(r.staffTerms).map(([staffId, t]) => ({ staff_id: staffId, staff_name: t.name, price_minor: t.priceMinor, duration_min: t.durationMin })),
      })),
    };
  });
}

// ── Holds ───────────────────────────────────────────────────────────────────
export type HoldItem = RequestedItem & { staffId: string; start: string };
export type HoldInput = {
  branchId?: string | null;
  items: HoldItem[];
  customer: { kind: 'user'; user: SessionUser } | { kind: 'tenant_customer'; tenantCustomerId: string };
  source: 'storefront' | 'dashboard' | 'walk_in' | 'waitlist';
  audience: Audience;
  customerNote?: string | null;
  internalNote?: string | null;
  idempotencyKey: string;
  actor: AuditActor;
  now?: Date;
};

/** Releases expired holds that could block these staff/resources (same transaction, before allocating). */
async function releaseExpiredHolds(trx: Tx, staffIds: string[], resourceIds: string[]) {
  const released = await trx.updateTable('booking_allocations').set({ state: 'released', released_at: new Date() })
    .where('state', '=', 'held').where('expires_at', '<=', new Date())
    .where((eb) => eb.or([
      ...(staffIds.length ? [eb('staff_id', 'in', staffIds)] : []),
      ...(resourceIds.length ? [eb('resource_id', 'in', resourceIds)] : []),
      eb.val(false),
    ]))
    .returning('booking_id').execute();
  const ids = [...new Set(released.map((r) => r.booking_id).filter((x): x is string => !!x))];
  if (ids.length) await expireBookings(trx, ids);
}

async function expireBookings(trx: Tx, bookingIds: string[]) {
  const rows = await trx.updateTable('bookings').set({ status: 'expired', version: sql`version + 1` })
    .where('id', 'in', bookingIds).where('status', 'in', ['held', 'pending_payment'])
    .returning(['id', 'tenant_id', 'status']).execute();
  for (const b of rows) {
    await trx.updateTable('booking_allocations').set({ state: 'released', released_at: new Date() }).where('booking_id', '=', b.id).where('state', '<>', 'released').execute();
    await trx.insertInto('booking_events').values({ tenant_id: b.tenant_id, booking_id: b.id, from_status: 'held', to_status: 'expired', source: 'system', reason: 'hold_expired' }).execute();
    await bookingHooks.onReleased(trx, b.tenant_id, b.id, 'expired');
  }
}

export async function policySnapshot(trx: Tx, tenantId: string) {
  const s = await trx.selectFrom('tenant_settings').selectAll().where('tenant_id', '=', tenantId).executeTakeFirstOrThrow();
  return {
    captured_at: new Date().toISOString(),
    free_cancellation_hours: s.free_cancellation_hours, late_cancellation_fee_bp: s.late_cancellation_fee_bp,
    no_show_grace_min: s.no_show_grace_min, tax_rate_bp: s.tax_rate_bp, prices_include_tax: s.prices_include_tax, tax_label: s.tax_label,
    hold_ttl_sec: s.hold_ttl_sec, booking_policy_text_ar: s.booking_policy_text_ar, booking_policy_text_en: s.booking_policy_text_en,
  };
}

export async function enabledMethods(trx: Tx, tenantId: string): Promise<PaymentMethod[]> {
  const acct = await trx.selectFrom('payment_accounts').select(['enabled_methods']).where('tenant_id', '=', tenantId).where('status', '=', 'active').execute();
  const s = await trx.selectFrom('tenant_settings').select(['allow_pay_on_site']).where('tenant_id', '=', tenantId).executeTakeFirstOrThrow();
  const methods = new Set<PaymentMethod>(acct.flatMap((a) => a.enabled_methods as PaymentMethod[]));
  if (s.allow_pay_on_site) { methods.add('cash'); methods.add('pos_terminal'); }
  return [...methods];
}

type AllocationRow = { staffId: string | null; resourceId: string | null; itemKey: string; start: number; end: number };

/**
 * Creates a time-limited hold. Re-validates availability inside the same
 * transaction that inserts the allocations; the exclusion constraints decide
 * any race (one winner, the other gets 409 slot_unavailable). Allocations are
 * inserted in a stable global order to avoid deadlocks between concurrent
 * multi-resource holds. Idempotent per (customer actor, key).
 */
export async function createHold(tenantId: string, input: HoldInput) {
  const now = input.now ?? new Date();
  const scope = `tenant:${tenantId}:actor:${input.actor.userId ?? 'anon'}`;
  const hash = requestHash({ items: input.items, branch: input.branchId, customer: input.customer.kind === 'tenant_customer' ? input.customer.tenantCustomerId : input.customer.user.userId, source: input.source });
  return withTenant(tenantId, (trx) => idempotent(trx, { scope, operation: 'booking.hold', key: input.idempotencyKey, hash }, async () => {
    const branch = input.branchId
      ? await trx.selectFrom('branches').select(['id', 'timezone']).where('id', '=', input.branchId).where('status', '=', 'active').executeTakeFirst()
      : await primaryBranch(trx, tenantId);
    if (!branch) throw Errors.invalid('branch_unavailable');
    const resolved = await resolveItems(trx, tenantId, branch.id, input.items, input.audience);

    const startsMs = input.items.map((i) => Date.parse(i.start));
    if (startsMs.some(Number.isNaN)) throw Errors.invalid('invalid_start');
    const firstDate = DateTime.fromMillis(Math.min(...startsMs), { zone: branch.timezone }).toISODate()!;
    const lastDate = DateTime.fromMillis(Math.max(...startsMs), { zone: branch.timezone }).toISODate()!;
    const staffIds = [...new Set(input.items.map((i) => i.staffId))];
    await releaseExpiredHolds(trx, staffIds, []);
    const engine = await loadEngineInput(trx, tenantId, branch.id, resolved, firstDate, lastDate, now);
    const check = validateItinerary(engine, resolved.map((r) => r.spec), input.items.map((i, idx) => ({ key: i.key, staffId: i.staffId, start: startsMs[idx]! })));
    if (!check.ok) throw new AppError(409, check.reason === 'slot_unavailable' || check.reason === 'resource_unavailable' ? 'slot_unavailable' : check.reason, 'The selected time is not available', { key: check.key });

    // Customer relationship (never browser-supplied ids for public bookings).
    const tenantCustomerId = input.customer.kind === 'user'
      ? await ensureTenantCustomerForUser(trx, tenantId, { userId: input.customer.user.userId, displayName: input.customer.user.displayName, phone: input.customer.user.phone, email: input.customer.user.email })
      : input.customer.tenantCustomerId;
    const tc = await trx.selectFrom('tenant_customers').select(['id', 'user_id', 'status']).where('id', '=', tenantCustomerId).executeTakeFirst();
    if (!tc || tc.status !== 'active') throw Errors.notFound('customer');

    const policy = await policySnapshot(trx, tenantId);
    const subtotal = check.plan.reduce((a, p) => a + resolved.find((r) => r.key === p.key)!.staffTerms[p.staffId]!.priceMinor, 0);
    const totals = computeTotals(subtotal, 0, policy.tax_rate_bp, policy.prices_include_tax);
    const terms = await computePaymentTerms(trx, {
      tenantId, tenantCustomerId, customerUserId: tc.user_id, amountDueMinor: totals.total, availableMethods: await enabledMethods(trx, tenantId), context: 'booking', now,
    });
    const requiresApproval = terms.requiresManualApproval || resolved.some((r) => r.service.requires_manual_approval);

    await releaseExpiredHolds(trx, [], [...new Set(check.plan.flatMap((p) => p.resourceIds))]);
    const holdExpires = new Date(now.getTime() + policy.hold_ttl_sec * 1000);
    const number = await nextReadableNumber(trx, tenantId, 'booking');
    const start = new Date(Math.min(...check.plan.map((p) => p.start)));
    const end = new Date(Math.max(...check.plan.map((p) => p.end)));
    const booking = await trx.insertInto('bookings').values({
      tenant_id: tenantId, branch_id: branch.id, number, tenant_customer_id: tenantCustomerId, customer_user_id: tc.user_id,
      status: 'held', source: input.source, starts_at: start, ends_at: end, timezone: branch.timezone,
      subtotal_minor: totals.subtotal, discount_minor: totals.discount, tax_minor: totals.tax, total_minor: totals.total,
      deposit_due_minor: terms.depositMinor ?? 0, currency: 'SAR',
      policy_snapshot: JSON.stringify(policy), payment_terms: JSON.stringify({ ...terms, requiresManualApproval: requiresApproval }),
      hold_expires_at: holdExpires, customer_note: input.customerNote ?? null, internal_note: input.internalNote ?? null,
      created_by: input.actor.userId,
    }).returning(['id', 'number']).executeTakeFirstOrThrow();

    const allocations: AllocationRow[] = [];
    for (const [seq, p] of check.plan.entries()) {
      const r = resolved.find((x) => x.key === p.key)!;
      const term = r.staffTerms[p.staffId]!;
      const item = await trx.insertInto('booking_items').values({
        tenant_id: tenantId, booking_id: booking.id, sequence: seq, service_id: r.service.id, variant_id: r.variant?.id ?? null, staff_id: p.staffId,
        starts_at: new Date(p.start), ends_at: new Date(p.end), buffer_before_min: r.spec.bufferBefore, buffer_after_min: r.spec.bufferAfter,
        service_name_ar: r.variant ? `${r.service.name_ar ?? ''}${r.variant.name_ar ? ` — ${r.variant.name_ar}` : ''}` : r.service.name_ar,
        service_name_en: r.variant ? `${r.service.name_en ?? ''}${r.variant.name_en ? ` — ${r.variant.name_en}` : ''}` : r.service.name_en,
        staff_name: term.name, duration_min: term.durationMin,
        unit_price_minor: term.priceMinor - r.addons.reduce((a, x) => a + x.price_minor, 0),
        addons: JSON.stringify(r.addons), addons_price_minor: r.addons.reduce((a, x) => a + x.price_minor, 0), line_total_minor: term.priceMinor,
      }).returning('id').executeTakeFirstOrThrow();
      allocations.push({ staffId: p.staffId, resourceId: null, itemKey: item.id, start: p.occupied.start, end: p.occupied.end });
      for (const res of p.resourceIds) allocations.push({ staffId: null, resourceId: res, itemKey: item.id, start: p.occupied.start, end: p.occupied.end });
    }
    // Stable order: resources/staff by id, then time.
    allocations.sort((a, b) => (a.staffId ?? a.resourceId!).localeCompare(b.staffId ?? b.resourceId!) || a.start - b.start);
    for (const a of allocations) {
      await trx.insertInto('booking_allocations').values({
        tenant_id: tenantId, booking_id: booking.id, booking_item_id: a.itemKey, staff_id: a.staffId, resource_id: a.resourceId,
        during: `[${new Date(a.start).toISOString()},${new Date(a.end).toISOString()})`, state: 'held', expires_at: holdExpires,
      }).execute();
    }
    await trx.insertInto('booking_events').values({
      tenant_id: tenantId, booking_id: booking.id, from_status: null, to_status: 'held', kind: 'created', actor_user_id: input.actor.userId,
      source: input.source, data: JSON.stringify({ items: check.plan.length, total_minor: totals.total }),
    }).execute();
    await audit(trx, input.actor, 'booking.held', { tenantId, targetType: 'booking', targetId: booking.id, data: { number: booking.number, total_minor: totals.total } });
    return {
      status: 201,
      body: {
        booking_id: booking.id, number: booking.number, status: 'held', hold_expires_at: holdExpires.toISOString(),
        totals, payment_terms: terms, requires_manual_approval: requiresApproval, timezone: branch.timezone,
        items: check.plan.map((p) => ({ key: p.key, staff_id: p.staffId, start: new Date(p.start).toISOString(), end: new Date(p.end).toISOString() })),
      },
    };
  }));
}

// ── Confirmation (called by checkout / payments) ────────────────────────────
/**
 * Converts the booking's held allocations to confirmed. Fails with 409
 * hold_expired if any allocation was released (the slot may have been taken).
 * `target` is confirmed, pending_approval (manual approval) or pending_payment.
 */
export async function applyHoldOutcome(trx: Tx, tenantId: string, bookingId: string, target: 'confirmed' | 'pending_approval' | 'pending_payment', actor: { userId: string | null; source: string; reason?: string }) {
  const b = await trx.selectFrom('bookings').selectAll().where('id', '=', bookingId).forUpdate().executeTakeFirst();
  if (!b) throw Errors.notFound('booking');
  if (b.status === target) return { changed: false, status: b.status };
  if (!['held', 'pending_payment'].includes(b.status)) throw Errors.conflict('invalid_transition', `Booking is ${b.status}`);
  const allocs = await trx.selectFrom('booking_allocations').select(['id', 'state', 'expires_at']).where('booking_id', '=', bookingId).execute();
  const now = new Date();
  if (!allocs.length || allocs.some((a) => a.state === 'released' || (a.state === 'held' && a.expires_at! <= now))) {
    throw Errors.conflict('hold_expired', 'The reserved time expired. Please choose a time again.');
  }
  if (target === 'pending_payment') {
    // Keep the hold; payment must complete before hold_expires_at.
    await trx.updateTable('bookings').set({ status: 'pending_payment', version: sql`version + 1` }).where('id', '=', bookingId).execute();
  } else {
    await trx.updateTable('booking_allocations').set({ state: 'confirmed', expires_at: null }).where('booking_id', '=', bookingId).where('state', '=', 'held').execute();
    await trx.updateTable('bookings').set({ status: target, hold_expires_at: null, version: sql`version + 1` }).where('id', '=', bookingId).execute();
  }
  await trx.insertInto('booking_events').values({ tenant_id: tenantId, booking_id: bookingId, from_status: b.status, to_status: target, actor_user_id: actor.userId, source: actor.source, reason: actor.reason ?? null }).execute();
  if (target === 'confirmed' || target === 'pending_approval') await announce(trx, tenantId, bookingId, target === 'confirmed' ? 'booking.confirmed' : 'booking.pending_approval');
  return { changed: true, status: target };
}

/**
 * Late payment success after a hold expired: re-allocate the same times only if
 * still free (exclusion constraints decide); otherwise the caller refunds.
 */
export async function tryReallocateExpired(trx: Tx, tenantId: string, bookingId: string): Promise<boolean> {
  const b = await trx.selectFrom('bookings').select(['status']).where('id', '=', bookingId).forUpdate().executeTakeFirstOrThrow();
  if (!['expired', 'held', 'pending_payment'].includes(b.status)) return false;
  const allocs = await trx.selectFrom('booking_allocations').select(['id', 'staff_id', 'resource_id', 'booking_item_id', sql<Date>`lower(during)`.as('s'), sql<Date>`upper(during)`.as('e')])
    .where('booking_id', '=', bookingId).execute();
  const sorted = [...allocs].sort((a, b2) => (a.staff_id ?? a.resource_id!).localeCompare(b2.staff_id ?? b2.resource_id!) || a.s.getTime() - b2.s.getTime());
  await sql`savepoint realloc`.execute(trx);
  try {
    await trx.updateTable('booking_allocations').set({ state: 'released', released_at: new Date() }).where('booking_id', '=', bookingId).where('state', '<>', 'released').execute();
    for (const a of sorted) {
      await trx.insertInto('booking_allocations').values({
        tenant_id: tenantId, booking_id: bookingId, booking_item_id: a.booking_item_id, staff_id: a.staff_id, resource_id: a.resource_id,
        during: `[${a.s.toISOString()},${a.e.toISOString()})`, state: 'confirmed',
      }).execute();
    }
    await sql`release savepoint realloc`.execute(trx);
  } catch (e) {
    await sql`rollback to savepoint realloc`.execute(trx);
    if ((e as { code?: string }).code === '23P01') return false;
    throw e;
  }
  await trx.updateTable('bookings').set({ status: 'confirmed', hold_expires_at: null, version: sql`version + 1` }).where('id', '=', bookingId).execute();
  await trx.insertInto('booking_events').values({ tenant_id: tenantId, booking_id: bookingId, from_status: b.status, to_status: 'confirmed', source: 'system', reason: 'late_payment_reallocated' }).execute();
  await announce(trx, tenantId, bookingId, 'booking.confirmed');
  return true;
}

async function announce(trx: Tx, tenantId: string, bookingId: string, topic: string) {
  const b = await trx.selectFrom('bookings').select(['id', 'number', 'customer_user_id', 'starts_at', 'timezone']).where('id', '=', bookingId).executeTakeFirstOrThrow();
  const t = await trx.selectFrom('tenants').select(['slug', 'name']).where('id', '=', tenantId).executeTakeFirstOrThrow();
  const when = DateTime.fromJSDate(b.starts_at, { zone: b.timezone });
  const titles: Record<string, [string, string]> = {
    'booking.confirmed': [`تم تأكيد موعدك في ${t.name}`, `Your appointment at ${t.name} is confirmed`],
    'booking.pending_approval': [`طلب حجزك في ${t.name} بانتظار الموافقة`, `Your booking request at ${t.name} awaits approval`],
    'booking.cancelled': [`تم إلغاء موعدك في ${t.name}`, `Your appointment at ${t.name} was cancelled`],
    'booking.rescheduled': [`تم تغيير موعدك في ${t.name}`, `Your appointment at ${t.name} was rescheduled`],
  };
  const [ar, en] = titles[topic] ?? [topic, topic];
  if (b.customer_user_id) {
    await notifyUsers(trx, tenantId, [b.customer_user_id], {
      kind: topic, title_ar: ar, title_en: en, body_ar: when.setLocale('ar').toFormat('cccc d LLLL، h:mm a'), body_en: when.setLocale('en').toFormat('cccc d LLLL, h:mm a'),
      target_path: `/account/bookings/${bookingId}`, dedupe_key: `${topic}:${bookingId}:${Date.now()}`,
    });
  }
  const staff = await trx.selectFrom('booking_items').select('staff_id').distinct().where('booking_id', '=', bookingId).where('superseded_at', 'is', null).execute();
  for (const s of staff) {
    await notifyStaff(trx, tenantId, s.staff_id, { kind: topic, title_ar: `${b.number}: ${ar}`, title_en: `${b.number}: ${en}`, target_path: '/staff' });
  }
  if (topic === 'booking.pending_approval') {
    await notifyCapability(trx, tenantId, ['bookings.manage'], { kind: topic, title_ar: `حجز ${b.number} يحتاج موافقة`, title_en: `Booking ${b.number} needs approval`, target_path: `/app/${t.slug}/bookings/${bookingId}` });
  }
  // Email/SMS/WhatsApp go through the outbox → messaging adapter (simulated until a provider is connected).
  await enqueue(trx, topic, { booking_id: bookingId }, { tenantId, dedupeKey: `${topic}:${bookingId}:${Date.now()}` });
}

// ── Reading ─────────────────────────────────────────────────────────────────
function canSeeAll(access: TenantAccess) {
  return hasCapability(access, ['bookings.view_all', 'bookings.view_financial']);
}

async function assignedFilter(trx: Tx, access: TenantAccess, bookingId: string) {
  if (canSeeAll(access)) return true;
  if (!access.staffProfileId || !hasCapability(access, 'bookings.view_assigned')) return false;
  const r = await trx.selectFrom('booking_items').select('id').where('booking_id', '=', bookingId).where('staff_id', '=', access.staffProfileId).executeTakeFirst();
  return !!r;
}

export async function getBooking(access: TenantAccess, bookingId: string) {
  return withTenant(access.tenantId, async (trx) => {
    const b = await trx.selectFrom('bookings').selectAll().where('id', '=', bookingId).executeTakeFirst();
    if (!b || !(await assignedFilter(trx, access, bookingId))) throw Errors.notFound('booking');
    const [items, events, customer, payments] = await Promise.all([
      trx.selectFrom('booking_items').selectAll().where('booking_id', '=', bookingId).orderBy('revision').orderBy('sequence').execute(),
      trx.selectFrom('booking_events').selectAll().where('booking_id', '=', bookingId).orderBy('created_at').execute(),
      trx.selectFrom('tenant_customers').select(['id', 'display_name', 'phone', 'email', 'private_notes', 'user_id']).where('id', '=', b.tenant_customer_id).executeTakeFirst(),
      hasCapability(access, ['bookings.view_financial', 'payments.collect', 'finance.view'])
        ? trx.selectFrom('payments').select(['id', 'kind', 'method', 'amount_minor', 'status', 'captured_at', 'needs_reconciliation']).where('booking_id', '=', bookingId).orderBy('created_at').execute()
        : Promise.resolve([]),
    ]);
    const showNotes = hasCapability(access, 'customers.view_notes');
    const financial = hasCapability(access, ['bookings.view_financial', 'bookings.manage', 'payments.collect']);
    return {
      ...b,
      internal_note: hasCapability(access, 'bookings.manage') ? b.internal_note : null,
      payment_terms: financial ? b.payment_terms : undefined,
      items: items.filter((i) => !i.superseded_at),
      history_items: items.filter((i) => !!i.superseded_at),
      events,
      customer: customer ? { id: customer.id, display_name: customer.display_name, phone: customer.phone, email: customer.email, has_account: !!customer.user_id, private_notes: showNotes ? customer.private_notes : undefined } : null,
      payments,
    };
  });
}

export async function listBookings(access: TenantAccess, f: { from?: string; to?: string; status?: string[]; staffId?: string; customerId?: string; q?: string; limit: number; cursor?: { starts_at: string; id: string } | null }) {
  return withTenant(access.tenantId, async (trx) => {
    let q = trx.selectFrom('bookings as b').innerJoin('tenant_customers as c', 'c.id', 'b.tenant_customer_id')
      .select(['b.id', 'b.number', 'b.status', 'b.payment_status', 'b.starts_at', 'b.ends_at', 'b.timezone', 'b.total_minor', 'b.paid_minor', 'b.source', 'c.display_name as customer_name',
        sql<string>`(select string_agg(coalesce(i.service_name_ar, i.service_name_en), ' + ' order by i.sequence) from booking_items i where i.booking_id = b.id and i.superseded_at is null)`.as('services'),
        sql<string>`(select string_agg(distinct i.staff_name, '، ') from booking_items i where i.booking_id = b.id and i.superseded_at is null)`.as('staff_names')]);
    if (!canSeeAll(access)) {
      if (!access.staffProfileId) return { items: [], next_cursor: null };
      q = q.where(sql<boolean>`exists (select 1 from booking_items i where i.booking_id = b.id and i.staff_id = ${access.staffProfileId} and i.superseded_at is null)`);
    }
    if (f.from) q = q.where('b.starts_at', '>=', new Date(f.from));
    if (f.to) q = q.where('b.starts_at', '<', new Date(f.to));
    if (f.status?.length) q = q.where('b.status', 'in', f.status);
    if (f.staffId) q = q.where(sql<boolean>`exists (select 1 from booking_items i where i.booking_id = b.id and i.staff_id = ${f.staffId} and i.superseded_at is null)`);
    if (f.customerId) q = q.where('b.tenant_customer_id', '=', f.customerId);
    if (f.q) q = q.where((eb) => eb.or([eb('b.number', 'ilike', `%${f.q}%`), eb('c.display_name', 'ilike', `%${f.q}%`)]));
    if (f.cursor) q = q.where(sql<boolean>`(b.starts_at, b.id) > (${new Date(f.cursor.starts_at)}, ${f.cursor.id})`);
    const rows = await q.orderBy('b.starts_at').orderBy('b.id').limit(f.limit + 1).execute();
    const items = rows.slice(0, f.limit);
    const last = items[items.length - 1];
    return { items, next_cursor: rows.length > f.limit && last ? { starts_at: last.starts_at.toISOString(), id: last.id } : null };
  });
}

// ── Transitions ─────────────────────────────────────────────────────────────
export type TransitionActor =
  | { kind: 'staff'; access: TenantAccess; audit: AuditActor }
  | { kind: 'customer'; userId: string; audit: AuditActor }
  | { kind: 'system'; audit: AuditActor };

/**
 * Executes one lifecycle transition through the TRANSITIONS table: checks the
 * actor's authority (capability, assigned specialist or own customer), guards
 * (no-show only after start + grace, customer cancellation before start, …),
 * applies side effects, and writes an append-only booking event + audit log.
 */
export async function transition(tenantId: string, bookingId: string, action: BookingAction, actor: TransitionActor, opts: { reason?: string; expectedVersion?: number; now?: Date } = {}) {
  const rule = TRANSITIONS[action];
  const now = opts.now ?? new Date();
  return withTenant(tenantId, async (trx) => {
    const b = await trx.selectFrom('bookings').selectAll().where('id', '=', bookingId).forUpdate().executeTakeFirst();
    if (!b) throw Errors.notFound('booking');
    // Authority
    if (actor.kind === 'staff') {
      const a = actor.access;
      const full = hasCapability(a, rule.staffCaps);
      let assigned = false;
      if (!full && rule.assignedCaps && hasCapability(a, rule.assignedCaps) && a.staffProfileId) {
        assigned = !!(await trx.selectFrom('booking_items').select('id').where('booking_id', '=', bookingId).where('staff_id', '=', a.staffProfileId).where('superseded_at', 'is', null).executeTakeFirst());
      }
      if (!full && !assigned) {
        const visible = await assignedFilter(trx, a, bookingId);
        throw visible ? Errors.forbidden() : Errors.notFound('booking');
      }
    } else if (actor.kind === 'customer') {
      if (!rule.customer || b.customer_user_id !== actor.userId) throw Errors.notFound('booking');
    } else if (!rule.system) throw Errors.forbidden();

    if (opts.expectedVersion != null && opts.expectedVersion !== b.version) throw Errors.versionConflict(b.version);
    if (!rule.from.includes(b.status as BookingStatus)) throw Errors.conflict('invalid_transition', `Cannot ${action} a booking that is ${b.status}`, { status: b.status });

    const policy = b.policy_snapshot as { no_show_grace_min?: number; free_cancellation_hours?: number; late_cancellation_fee_bp?: number };
    for (const g of rule.guards) {
      if (g === 'not_before_start_plus_grace') {
        const allowedAt = b.starts_at.getTime() + (policy.no_show_grace_min ?? 15) * MIN;
        if (now.getTime() < allowedAt) throw Errors.invalid('too_early_for_no_show', 'A no-show can only be recorded after the appointment time plus the grace period', { allowed_at: new Date(allowedAt).toISOString() });
      }
      if (g === 'customer_before_start' && actor.kind === 'customer' && now >= b.starts_at) throw Errors.invalid('appointment_started', 'This appointment has already started; please contact the business');
      if (g === 'within_service_day') {
        const startDay = DateTime.fromJSDate(b.starts_at, { zone: b.timezone }).toISODate();
        const today = DateTime.fromJSDate(now, { zone: b.timezone }).toISODate();
        if (startDay !== today) throw Errors.invalid('not_service_day', 'Check-in and service start are only possible on the appointment day');
      }
      if (g === 'reason_required' && actor.kind !== 'system' && !(opts.reason && opts.reason.trim().length >= 3)) throw Errors.invalid('reason_required', 'Please give a reason');
    }

    const patch: Record<string, unknown> = { status: rule.to, version: sql`version + 1` };
    let refund: ReturnType<typeof cancellationRefund> | null = null;
    if (action === 'cancel' || action === 'reject') {
      const source = actor.kind === 'customer' ? 'customer' : actor.kind === 'system' ? 'system' : 'business';
      Object.assign(patch, { cancelled_at: now, cancelled_by: actor.audit.userId, cancel_source: source, cancel_reason: opts.reason ?? null });
      refund = cancellationRefund({
        paidMinor: b.paid_minor - b.refunded_minor, totalMinor: b.total_minor, startsAt: b.starts_at, now, source,
        freeCancellationHours: policy.free_cancellation_hours ?? 24, lateFeeBp: policy.late_cancellation_fee_bp ?? 0,
      });
    }
    if (action === 'start') {
      await trx.updateTable('booking_items').set({ actual_started_at: now }).where('booking_id', '=', bookingId).where('superseded_at', 'is', null).where('actual_started_at', 'is', null).where('sequence', '=', 0).execute();
    }
    if (action === 'complete') {
      await trx.updateTable('booking_items').set({ actual_ended_at: now }).where('booking_id', '=', bookingId).where('superseded_at', 'is', null).where('actual_ended_at', 'is', null).execute();
      await trx.updateTable('booking_items').set({ actual_started_at: sql`coalesce(actual_started_at, ${now})` }).where('booking_id', '=', bookingId).where('superseded_at', 'is', null).execute();
    }
    await trx.updateTable('bookings').set(patch).where('id', '=', bookingId).execute();
    if (rule.releasesAllocations) {
      await trx.updateTable('booking_allocations').set({ state: 'released', released_at: now }).where('booking_id', '=', bookingId).where('state', '<>', 'released').execute();
    }
    await trx.insertInto('booking_events').values({
      tenant_id: tenantId, booking_id: bookingId, from_status: b.status, to_status: rule.to, actor_user_id: actor.audit.userId,
      actor_role: actor.kind === 'staff' ? actor.access.role : actor.kind, source: actor.kind, reason: opts.reason ?? null,
      data: JSON.stringify(refund ? { refund } : {}),
    }).execute();
    await audit(trx, actor.audit, `booking.${action}`, { tenantId, targetType: 'booking', targetId: bookingId, data: { from: b.status, to: rule.to, reason: opts.reason, refund_due_minor: refund?.refundMinor } });

    // Side effects in the same transaction (exactly-once by their own constraints).
    if (action === 'complete') await bookingHooks.onCompleted(trx, tenantId, bookingId, actor.audit.userId);
    // Refunds first, so whatever is retained under the policy is what remains afterwards.
    if ((action === 'cancel' || action === 'reject') && refund && refund.refundMinor > 0) await bookingHooks.onRefundDue(trx, tenantId, bookingId, refund.refundMinor, refund.basis, actor.audit);
    if (action === 'cancel' || action === 'reject' || action === 'no_show') await bookingHooks.onReleased(trx, tenantId, bookingId, action === 'no_show' ? 'no_show' : 'cancelled');
    if (action === 'approve') await announce(trx, tenantId, bookingId, 'booking.confirmed');
    if (action === 'cancel' || action === 'reject') await announce(trx, tenantId, bookingId, 'booking.cancelled');
    if (action === 'cancel' || action === 'no_show') await bookingHooks.onSlotFreed(trx, tenantId, bookingId);
    return { id: bookingId, status: rule.to, refund_due_minor: refund?.refundMinor ?? 0, refund_basis: refund?.basis ?? null };
  });
}

// ── Reschedule ──────────────────────────────────────────────────────────────
/**
 * Atomically reserves the replacement and releases the original inside one
 * transaction: if the new time cannot be allocated, everything rolls back and
 * the original stays booked. Price changes require explicit acceptance.
 */
export async function reschedule(tenantId: string, bookingId: string, actor: TransitionActor, input: { items: HoldItem[]; acceptTotalMinor?: number; now?: Date }) {
  const now = input.now ?? new Date();
  return withTenant(tenantId, async (trx) => {
    const b = await trx.selectFrom('bookings').selectAll().where('id', '=', bookingId).forUpdate().executeTakeFirst();
    if (!b) throw Errors.notFound('booking');
    if (actor.kind === 'customer') {
      if (b.customer_user_id !== actor.userId) throw Errors.notFound('booking');
      if (now >= b.starts_at) throw Errors.invalid('appointment_started');
    } else if (actor.kind === 'staff' && !hasCapability(actor.access, 'bookings.manage')) throw Errors.forbidden();
    if (!['confirmed', 'pending_approval'].includes(b.status)) throw Errors.conflict('invalid_transition', `Cannot reschedule a booking that is ${b.status}`);

    const audience: Audience = actor.kind === 'staff' ? 'internal' : 'public';
    const resolved = await resolveItems(trx, tenantId, b.branch_id, input.items, audience);
    const startsMs = input.items.map((i) => Date.parse(i.start));
    // Release the original allocations first (same transaction): if anything below fails, this is rolled back.
    await trx.updateTable('booking_allocations').set({ state: 'released', released_at: now }).where('booking_id', '=', bookingId).where('state', '<>', 'released').execute();
    const firstDate = DateTime.fromMillis(Math.min(...startsMs), { zone: b.timezone }).toISODate()!;
    const lastDate = DateTime.fromMillis(Math.max(...startsMs), { zone: b.timezone }).toISODate()!;
    const engine = await loadEngineInput(trx, tenantId, b.branch_id, resolved, firstDate, lastDate, now);
    const check = validateItinerary(engine, resolved.map((r) => r.spec), input.items.map((i, idx) => ({ key: i.key, staffId: i.staffId, start: startsMs[idx]! })));
    if (!check.ok) throw new AppError(409, 'slot_unavailable', 'The new time is not available; your original appointment is unchanged', { key: check.key, reason: check.reason });

    const policy = b.policy_snapshot as { tax_rate_bp?: number; prices_include_tax?: boolean };
    const subtotal = check.plan.reduce((a, p) => a + resolved.find((r) => r.key === p.key)!.staffTerms[p.staffId]!.priceMinor, 0);
    const totals = computeTotals(subtotal, b.discount_minor, policy.tax_rate_bp ?? 0, policy.prices_include_tax ?? true);
    if (totals.total !== b.total_minor && input.acceptTotalMinor !== totals.total) {
      throw Errors.conflict('price_changed', 'The new appointment has a different price. Review and confirm the new total.', { old_total_minor: b.total_minor, new_total_minor: totals.total });
    }
    const revision = b.revision + 1;
    await trx.updateTable('booking_items').set({ superseded_at: now }).where('booking_id', '=', bookingId).where('superseded_at', 'is', null).execute();
    const allocations: AllocationRow[] = [];
    for (const [seq, p] of check.plan.entries()) {
      const r = resolved.find((x) => x.key === p.key)!;
      const term = r.staffTerms[p.staffId]!;
      const item = await trx.insertInto('booking_items').values({
        tenant_id: tenantId, booking_id: bookingId, sequence: seq, revision, service_id: r.service.id, variant_id: r.variant?.id ?? null, staff_id: p.staffId,
        starts_at: new Date(p.start), ends_at: new Date(p.end), buffer_before_min: r.spec.bufferBefore, buffer_after_min: r.spec.bufferAfter,
        service_name_ar: r.service.name_ar, service_name_en: r.service.name_en, staff_name: term.name, duration_min: term.durationMin,
        unit_price_minor: term.priceMinor - r.addons.reduce((a, x) => a + x.price_minor, 0), addons: JSON.stringify(r.addons),
        addons_price_minor: r.addons.reduce((a, x) => a + x.price_minor, 0), line_total_minor: term.priceMinor,
      }).returning('id').executeTakeFirstOrThrow();
      allocations.push({ staffId: p.staffId, resourceId: null, itemKey: item.id, start: p.occupied.start, end: p.occupied.end });
      for (const res of p.resourceIds) allocations.push({ staffId: null, resourceId: res, itemKey: item.id, start: p.occupied.start, end: p.occupied.end });
    }
    allocations.sort((a, c) => (a.staffId ?? a.resourceId!).localeCompare(c.staffId ?? c.resourceId!) || a.start - c.start);
    for (const a of allocations) {
      await trx.insertInto('booking_allocations').values({
        tenant_id: tenantId, booking_id: bookingId, booking_item_id: a.itemKey, staff_id: a.staffId, resource_id: a.resourceId,
        during: `[${new Date(a.start).toISOString()},${new Date(a.end).toISOString()})`, state: 'confirmed',
      }).execute();
    }
    const paid = b.paid_minor - b.refunded_minor;
    await trx.updateTable('bookings').set({
      starts_at: new Date(Math.min(...check.plan.map((p) => p.start))), ends_at: new Date(Math.max(...check.plan.map((p) => p.end))),
      subtotal_minor: totals.subtotal, tax_minor: totals.tax, total_minor: totals.total, revision,
      payment_status: paid <= 0 ? 'unpaid' : paid >= totals.total ? 'paid' : 'partially_paid',
      version: sql`version + 1`,
    }).where('id', '=', bookingId).execute();
    await trx.insertInto('booking_events').values({
      tenant_id: tenantId, booking_id: bookingId, from_status: b.status, to_status: b.status, kind: 'rescheduled', actor_user_id: actor.audit.userId,
      source: actor.kind, data: JSON.stringify({ from: { starts_at: b.starts_at, total_minor: b.total_minor }, to: { revision, total_minor: totals.total } }),
    }).execute();
    await audit(trx, actor.audit, 'booking.rescheduled', { tenantId, targetType: 'booking', targetId: bookingId, data: { revision, total_from: b.total_minor, total_to: totals.total } });
    if (paid > totals.total) await bookingHooks.onRefundDue(trx, tenantId, bookingId, paid - totals.total, 'reschedule_price_decrease', actor.audit);
    await announce(trx, tenantId, bookingId, 'booking.rescheduled');
    await bookingHooks.onSlotFreed(trx, tenantId, bookingId);
    return { id: bookingId, revision, total_minor: totals.total, balance_due_minor: Math.max(0, totals.total - paid) };
  });
}

// ── Sweeper ─────────────────────────────────────────────────────────────────
/** Expires holds past their TTL (exactly once; idempotent). Runs from the worker. */
export async function expireStaleHolds(now = new Date()) {
  const due = await withSystem('find expired holds', (trx) => trx.selectFrom('bookings').select(['id', 'tenant_id'])
    .where('status', 'in', ['held', 'pending_payment']).where('hold_expires_at', '<=', now).limit(500).execute());
  for (const d of due) {
    await withTenant(d.tenant_id, (trx) => expireBookings(trx, [d.id]));
  }
  return due.length;
}

export { ACTIVE_STATUSES };
