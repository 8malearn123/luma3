import { sql } from 'kysely';
import { DateTime } from 'luxon';
import { withTenant, type Tx } from '../../db/client';
import { AppError, Errors, isPgCode } from '../../http/errors';
import { audit, type AuditActor } from '../../infra/audit';
import { idempotent, requestHash } from '../../infra/idempotency';
import { notifyCapability, notifyUsers } from '../../infra/notify';
import type { SessionUser } from '../../auth/service';
import type { TenantAccess } from '../../tenancy/access';
import { ensureTenantCustomerForUser } from '../customers/relationship';
import { computeTotals } from '../booking/pricing';
import { policySnapshot, releaseExpiredHolds } from '../booking/service';
import { post } from '../finance/journal';
import { applyCapturedPayment, createEventCheckout, refundEventDue } from '../payments/service';
import {
  depositFromPercent, eventCancellationRefund, type EventQuoteInput, type EventRequestInput, type EventStatus,
} from '@/shared/schemas/events';

/**
 * Event bookings («حجوزات المناسبات»): weddings, graduations, group makeup.
 *
 * request (customer) → quote (business) → accept + deposit (customer, online)
 * → confirmed (on capture) → completed; balance is due on the day.
 *
 * The expert's time is reserved with a booking_allocations row owned by the
 * event booking — the same exclusion constraints and availability loader as
 * individual bookings — held while the deposit is being paid and confirmed on
 * capture. Money moves only through the payments service (provider checkout,
 * verified webhooks, system refunds). Cancellation reads the quote snapshot.
 */

/** How long the expert's time is held while the customer pays the deposit. */
export const EVENT_PAYMENT_TTL_MIN = 30;

export type EventSettings = {
  enabled: boolean; default_deposit_bp: number; free_cancellation_days: number; quote_validity_days: number; max_people: number;
  intro_ar: string | null; intro_en: string | null;
};
export const DEFAULT_EVENT_SETTINGS: EventSettings = {
  enabled: true, default_deposit_bp: 3000, free_cancellation_days: 7, quote_validity_days: 3, max_people: 30, intro_ar: null, intro_en: null,
};

type EventRow = Awaited<ReturnType<typeof lockEvent>>;
type Snapshot = { free_cancellation_days?: number; tax_rate_bp?: number; prices_include_tax?: boolean; tax_label?: string | null; captured_at?: string };

export async function getEventSettings(trx: Tx, tenantId: string): Promise<EventSettings> {
  const r = await trx.selectFrom('event_settings').select(['enabled', 'default_deposit_bp', 'free_cancellation_days', 'quote_validity_days', 'max_people', 'intro_ar', 'intro_en'])
    .where('tenant_id', '=', tenantId).executeTakeFirst();
  return r ?? DEFAULT_EVENT_SETTINGS;
}

export async function readEventSettings(tenantId: string) {
  return withTenant(tenantId, (trx) => getEventSettings(trx, tenantId));
}

export async function updateEventSettings(access: TenantAccess, actor: AuditActor, input: Partial<EventSettings>) {
  return withTenant(access.tenantId, async (trx) => {
    const cur = await getEventSettings(trx, access.tenantId);
    const next = { ...cur, ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) } as EventSettings;
    await trx.insertInto('event_settings').values({ tenant_id: access.tenantId, ...next, updated_by: actor.userId })
      .onConflict((oc) => oc.column('tenant_id').doUpdateSet({ ...next, updated_by: actor.userId })).execute();
    await audit(trx, actor, 'event_settings.updated', { tenantId: access.tenantId, targetType: 'event_settings', targetId: access.tenantId, data: input });
    return next;
  });
}

async function tenantSlug(trx: Tx, tenantId: string) {
  return String((await trx.selectFrom('tenants').select('slug').where('id', '=', tenantId).executeTakeFirstOrThrow()).slug);
}

async function nextEventNumber(trx: Tx, tenantId: string) {
  const r = await sql<{ value: number }>`
    insert into tenant_counters (tenant_id, kind, value) values (${tenantId}, 'event', 1)
    on conflict (tenant_id, kind) do update set value = tenant_counters.value + 1 returning value`.execute(trx);
  return `EVT-${String(r.rows[0]!.value).padStart(6, '0')}`;
}

/** The business's local timezone for events (primary branch, else the business). */
async function eventTimezone(trx: Tx, tenantId: string) {
  const b = await trx.selectFrom('branches').select('timezone').where('tenant_id', '=', tenantId).where('status', '=', 'active').orderBy('is_primary', 'desc').orderBy('created_at').executeTakeFirst();
  if (b?.timezone) return b.timezone;
  return (await trx.selectFrom('tenants').select('timezone').where('id', '=', tenantId).executeTakeFirstOrThrow()).timezone;
}

function lockEvent(trx: Tx, id: string) {
  return trx.selectFrom('event_bookings').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
}

const occupied = (e: { starts_at: Date; ends_at: Date | null; prep_before_min: number; prep_after_min: number }) => {
  const s = new Date(e.starts_at.getTime() - e.prep_before_min * 60_000);
  const end = new Date(e.ends_at!.getTime() + e.prep_after_min * 60_000);
  return { s, e: end, range: `[${s.toISOString()},${end.toISOString()})` };
};

async function releaseAllocations(trx: Tx, eventId: string) {
  await trx.updateTable('booking_allocations').set({ state: 'released', released_at: new Date() })
    .where('event_booking_id', '=', eventId).where('state', '<>', 'released').execute();
}

/**
 * Lazy expiry (also run on every read): a quote past its expiry becomes
 * `expired`; a deposit checkout past its window returns to `quoted` (or
 * `expired`) and frees the held time.
 */
async function settleTimeouts(trx: Tx, e: NonNullable<EventRow>, now = new Date()): Promise<NonNullable<EventRow>> {
  if (e.status === 'pending_payment' && e.payment_expires_at && e.payment_expires_at <= now) {
    await releaseAllocations(trx, e.id);
    await trx.updateTable('payments').set({ status: 'expired' }).where('event_booking_id', '=', e.id).where('status', 'in', ['pending', 'requires_action']).execute();
    const status: EventStatus = e.quote_expires_at && e.quote_expires_at > now ? 'quoted' : 'expired';
    return trx.updateTable('event_bookings').set({ status, payment_expires_at: null, version: sql`version + 1` }).where('id', '=', e.id).returningAll().executeTakeFirstOrThrow();
  }
  if (e.status === 'quoted' && e.quote_expires_at && e.quote_expires_at <= now) {
    return trx.updateTable('event_bookings').set({ status: 'expired', version: sql`version + 1` }).where('id', '=', e.id).returningAll().executeTakeFirstOrThrow();
  }
  return e;
}

/** Periodic sweep entry: applies lazy expiry to one event booking. */
export async function expireEventTimeouts(trx: Tx, id: string) {
  const e = await lockEvent(trx, id);
  if (e) await settleTimeouts(trx, e);
}

/** Busy check for a quote (advisory; the allocation's exclusion constraint is final). */
async function staffBusy(trx: Tx, staffId: string, s: Date, e: Date, exceptEventId?: string) {
  const range = sql`tstzrange(${s.toISOString()}::timestamptz, ${e.toISOString()}::timestamptz, '[)')`;
  const now = new Date();
  const alloc = await trx.selectFrom('booking_allocations').select('id').where('staff_id', '=', staffId).where(sql<boolean>`during && ${range}`)
    .where((eb) => eb.or([eb('state', '=', 'confirmed'), eb.and([eb('state', '=', 'held'), eb('expires_at', '>', now)])]))
    .$if(!!exceptEventId, (q) => q.where((eb) => eb.or([eb('event_booking_id', 'is', null), eb('event_booking_id', '<>', exceptEventId!)])))
    .executeTakeFirst();
  if (alloc) return 'booked';
  const block = await trx.selectFrom('time_blocks').select('id').where('staff_id', '=', staffId).where(sql<boolean>`during && ${range}`).executeTakeFirst();
  if (block) return 'blocked';
  const leave = await trx.selectFrom('leave_requests').select('id').where('staff_id', '=', staffId).where('status', '=', 'approved').where(sql<boolean>`during && ${range}`).executeTakeFirst();
  return leave ? 'on_leave' : null;
}

// ── Customer: request ───────────────────────────────────────────────────────
export async function createEventRequest(tenantId: string, user: SessionUser, input: EventRequestInput, idempotencyKey: string, actor: AuditActor) {
  return withTenant(tenantId, (trx) => idempotent(trx, { scope: `tenant:${tenantId}:user:${user.userId}`, operation: 'event.request', key: idempotencyKey, hash: requestHash(input) }, async () => {
    const settings = await getEventSettings(trx, tenantId);
    if (!settings.enabled) throw Errors.notFound('event_bookings');
    if (input.people_count > settings.max_people) throw Errors.invalid('too_many_people', `At most ${settings.max_people} people per event`, { max_people: settings.max_people });
    const tz = await eventTimezone(trx, tenantId);
    const start = DateTime.fromISO(`${input.event_date}T${input.start_time}`, { zone: tz });
    if (!start.isValid) throw Errors.invalid('invalid_date');
    if (start.toMillis() <= Date.now()) throw Errors.invalid('in_past', 'Choose a future date');
    if (start.toMillis() > Date.now() + 400 * 86_400_000) throw Errors.invalid('beyond_booking_window', 'Choose a date within the next year');
    const serviceIds = [...new Set(input.service_ids)];
    if (serviceIds.length) {
      const ok = await trx.selectFrom('services').select('id').where('id', 'in', serviceIds).where('archived_at', 'is', null).where('is_active', '=', true).where('is_visible', '=', true).execute();
      if (ok.length !== serviceIds.length) throw Errors.invalid('service_unavailable', 'A selected service is not available');
    }
    const tcId = await ensureTenantCustomerForUser(trx, tenantId, { userId: user.userId, displayName: user.displayName, phone: user.phone, email: user.email });
    const number = await nextEventNumber(trx, tenantId);
    const row = await trx.insertInto('event_bookings').values({
      tenant_id: tenantId, number, tenant_customer_id: tcId, customer_user_id: user.userId, status: 'requested', occasion: input.occasion,
      event_date: input.event_date, start_time: input.start_time, timezone: tz, starts_at: start.toJSDate(),
      location_type: input.location_type, location_text: input.location_text?.trim() || null, people_count: input.people_count,
      service_ids: serviceIds, notes: input.notes?.trim() || null, contact_phone: input.contact_phone?.trim() || null,
    }).returning(['id', 'number', 'status']).executeTakeFirstOrThrow();
    const slug = await tenantSlug(trx, tenantId);
    await notifyCapability(trx, tenantId, ['bookings.manage'], {
      kind: 'event.requested', title_ar: `طلب حجز مناسبة جديد ${number}`, title_en: `New event booking request ${number}`,
      body_ar: `${input.people_count} أشخاص · ${input.event_date}`, body_en: `${input.people_count} people · ${input.event_date}`,
      target_path: `/app/${slug}/events?id=${row.id}`, data: { event_booking_id: row.id }, dedupe_key: `event.requested:${row.id}`,
    });
    await audit(trx, actor, 'event.requested', { tenantId, targetType: 'event_booking', targetId: row.id, data: { occasion: input.occasion, people: input.people_count } });
    return { status: 201, body: row };
  }));
}

// ── Reads ───────────────────────────────────────────────────────────────────
const CUSTOMER_FIELDS = ['id', 'number', 'status', 'occasion', 'event_date', 'start_time', 'timezone', 'starts_at', 'ends_at', 'location_type', 'location_text',
  'people_count', 'service_ids', 'notes', 'subtotal_minor', 'tax_minor', 'total_minor', 'deposit_minor', 'currency', 'quote_note', 'quote_expires_at', 'quote_version',
  'paid_minor', 'refunded_minor', 'payment_expires_at', 'policy_snapshot', 'cancelled_at', 'cancel_source', 'decline_reason', 'created_at'] as const;

function customerView(e: NonNullable<EventRow>, staffName: string | null) {
  const out: Record<string, unknown> = { staff_name: staffName, balance_due_minor: e.total_minor == null ? null : Math.max(0, e.total_minor - e.paid_minor) };
  for (const k of CUSTOMER_FIELDS) out[k] = e[k];
  const snap = e.policy_snapshot as Snapshot;
  out.free_cancellation_days = snap.free_cancellation_days ?? null;
  out.can_accept = e.status === 'quoted';
  out.can_cancel = ['requested', 'quoted', 'pending_payment', 'confirmed'].includes(e.status) && e.starts_at > new Date();
  return out;
}

async function staffName(trx: Tx, staffId: string | null) {
  if (!staffId) return null;
  return (await trx.selectFrom('staff_profiles').select('display_name').where('id', '=', staffId).executeTakeFirst())?.display_name ?? null;
}

export async function getMyEventBooking(tenantId: string, userId: string, id: string) {
  return withTenant(tenantId, async (trx) => {
    const locked = await lockEvent(trx, id);
    if (!locked || locked.customer_user_id !== userId) throw Errors.notFound('event_booking');
    const e = await settleTimeouts(trx, locked);
    return customerView(e, await staffName(trx, e.staff_id));
  });
}

export async function listMyEventBookings(tenantId: string, userId: string) {
  return withTenant(tenantId, async (trx) => {
    const rows = await trx.selectFrom('event_bookings').select(['id', 'number', 'status', 'occasion', 'starts_at', 'timezone', 'people_count', 'total_minor', 'deposit_minor', 'currency', 'quote_expires_at', 'created_at'])
      .where('customer_user_id', '=', userId).orderBy('created_at', 'desc').limit(50).execute();
    const now = new Date();
    return rows.map((r) => ({ ...r, status: r.status === 'quoted' && r.quote_expires_at && r.quote_expires_at <= now ? 'expired' : r.status }));
  });
}

export async function listEventBookings(access: TenantAccess, f: { status?: string[]; limit?: number }) {
  return withTenant(access.tenantId, async (trx) => {
    const now = new Date();
    const rows = await trx.selectFrom('event_bookings as e').innerJoin('tenant_customers as c', 'c.id', 'e.tenant_customer_id')
      .leftJoin('staff_profiles as s', 's.id', 'e.staff_id')
      .select(['e.id', 'e.number', 'e.status', 'e.occasion', 'e.starts_at', 'e.ends_at', 'e.timezone', 'e.event_date', 'e.start_time', 'e.location_type', 'e.location_text', 'e.people_count',
        'e.total_minor', 'e.deposit_minor', 'e.paid_minor', 'e.refunded_minor', 'e.currency', 'e.quote_expires_at', 'e.created_at', 'c.display_name as customer_name', 's.display_name as staff_name'])
      .$if(!!f.status?.length, (q) => q.where('e.status', 'in', f.status!))
      .orderBy('e.starts_at', 'asc').limit(f.limit ?? 200).execute();
    return rows.map((r) => ({ ...r, status: r.status === 'quoted' && r.quote_expires_at && r.quote_expires_at <= now ? 'expired' : r.status }));
  });
}

export async function getEventBooking(access: TenantAccess, id: string) {
  return withTenant(access.tenantId, async (trx) => {
    const locked = await lockEvent(trx, id);
    if (!locked) throw Errors.notFound('event_booking');
    const e = await settleTimeouts(trx, locked);
    const customer = await trx.selectFrom('tenant_customers').select(['id', 'display_name', 'phone', 'email']).where('id', '=', e.tenant_customer_id).executeTakeFirstOrThrow();
    const services = e.service_ids.length ? await trx.selectFrom('services').select(['id', 'name_ar', 'name_en', 'price_minor', 'duration_min']).where('id', 'in', e.service_ids).execute() : [];
    const payments = await trx.selectFrom('payments').select(['id', 'kind', 'method', 'status', 'amount_minor', 'captured_at', 'created_at']).where('event_booking_id', '=', e.id).orderBy('created_at').execute();
    const refunds = payments.length ? await trx.selectFrom('refunds').select(['id', 'payment_id', 'amount_minor', 'status', 'reason', 'created_at']).where('payment_id', 'in', payments.map((p) => p.id)).orderBy('created_at').execute() : [];
    return { ...e, staff_name: await staffName(trx, e.staff_id), customer, services, payments, refunds, balance_due_minor: e.total_minor == null ? null : Math.max(0, e.total_minor - e.paid_minor) };
  });
}

// ── Business: quote / decline ───────────────────────────────────────────────
export async function sendQuote(access: TenantAccess, actor: AuditActor, id: string, input: EventQuoteInput) {
  return withTenant(access.tenantId, async (trx) => {
    const locked = await lockEvent(trx, id);
    if (!locked) throw Errors.notFound('event_booking');
    const e = await settleTimeouts(trx, locked);
    if (!['requested', 'quoted', 'expired'].includes(e.status)) throw Errors.conflict('invalid_transition', `Event booking is ${e.status}`);
    if (e.status === 'expired' && e.quoted_at == null) throw Errors.conflict('invalid_transition');
    if (e.starts_at <= new Date()) throw Errors.invalid('in_past', 'The event date has passed');
    const staffId = input.staff_id ?? access.staffProfileId
      ?? (await trx.selectFrom('staff_profiles').select('id').where('archived_at', 'is', null).where('is_active', '=', true).orderBy('sort').orderBy('created_at').executeTakeFirst())?.id;
    if (!staffId) throw Errors.invalid('staff_required', 'Choose who will do this event');
    const staff = await trx.selectFrom('staff_profiles').select(['id', 'is_active', 'archived_at']).where('id', '=', staffId).executeTakeFirst();
    if (!staff || !staff.is_active || staff.archived_at) throw Errors.invalid('staff_unavailable');
    const endsAt = new Date(e.starts_at.getTime() + input.duration_min * 60_000);
    const occ = occupied({ starts_at: e.starts_at, ends_at: endsAt, prep_before_min: input.prep_before_min, prep_after_min: input.prep_after_min });
    const busy = await staffBusy(trx, staffId, occ.s, occ.e, e.id);
    if (busy) throw Errors.conflict('slot_unavailable', 'The specialist is not free at that time', { reason: busy });
    const settings = await getEventSettings(trx, access.tenantId);
    const policy = await policySnapshot(trx, access.tenantId);
    const totals = computeTotals(input.price_minor, 0, policy.tax_rate_bp, policy.prices_include_tax);
    const deposit = input.deposit.mode === 'percent' ? depositFromPercent(totals.total, input.deposit.percent_bp) : Math.min(totals.total, input.deposit.amount_minor);
    if (!(deposit > 0)) throw Errors.invalid('invalid_deposit');
    const validDays = input.valid_days ?? settings.quote_validity_days;
    const expires = new Date(Math.min(Date.now() + validDays * 86_400_000, occ.s.getTime()));
    const snapshot: Snapshot = {
      free_cancellation_days: settings.free_cancellation_days, tax_rate_bp: policy.tax_rate_bp, prices_include_tax: policy.prices_include_tax,
      tax_label: policy.tax_label, captured_at: new Date().toISOString(),
    };
    const row = await trx.updateTable('event_bookings').set({
      status: 'quoted', staff_id: staffId, duration_min: input.duration_min, prep_before_min: input.prep_before_min, prep_after_min: input.prep_after_min, ends_at: endsAt,
      subtotal_minor: totals.subtotal, tax_minor: totals.tax, total_minor: totals.total, deposit_minor: deposit, quote_note: input.note?.trim() || null,
      quote_expires_at: expires, quoted_at: new Date(), quoted_by: actor.userId, quote_version: sql`quote_version + 1`, version: sql`version + 1`,
      policy_snapshot: JSON.stringify(snapshot),
    }).where('id', '=', e.id).returningAll().executeTakeFirstOrThrow();
    const slug = await tenantSlug(trx, access.tenantId);
    await notifyUsers(trx, access.tenantId, [e.customer_user_id], {
      kind: 'event.quoted', title_ar: `وصلكِ عرض سعر لمناسبتكِ ${e.number}`, title_en: `You have a quote for your event ${e.number}`,
      body_ar: 'راجعي العرض وادفعي العربون لتأكيد الحجز قبل انتهاء صلاحيته.', body_en: 'Review the quote and pay the deposit to confirm before it expires.',
      target_path: `/s/${slug}/events/${e.id}`, data: { event_booking_id: e.id, quote_version: row.quote_version },
    });
    await audit(trx, actor, 'event.quoted', { tenantId: access.tenantId, targetType: 'event_booking', targetId: e.id, data: { total_minor: totals.total, deposit_minor: deposit, staff_id: staffId, quote_version: row.quote_version } });
    return row;
  });
}

export async function declineRequest(access: TenantAccess, actor: AuditActor, id: string, reason: string) {
  return withTenant(access.tenantId, async (trx) => {
    const locked = await lockEvent(trx, id);
    if (!locked) throw Errors.notFound('event_booking');
    const e = await settleTimeouts(trx, locked);
    if (!['requested', 'quoted', 'expired'].includes(e.status)) throw Errors.conflict('invalid_transition', `Event booking is ${e.status}`);
    const row = await trx.updateTable('event_bookings').set({ status: 'declined', decline_reason: reason, version: sql`version + 1` }).where('id', '=', e.id).returningAll().executeTakeFirstOrThrow();
    const slug = await tenantSlug(trx, access.tenantId);
    await notifyUsers(trx, access.tenantId, [e.customer_user_id], {
      kind: 'event.declined', title_ar: `نعتذر، لا يمكننا تلبية طلب المناسبة ${e.number}`, title_en: `Sorry, we can't take event request ${e.number}`,
      body_ar: reason, body_en: reason, target_path: `/s/${slug}/events/${e.id}`,
    });
    await audit(trx, actor, 'event.declined', { tenantId: access.tenantId, targetType: 'event_booking', targetId: e.id, data: { reason } });
    return row;
  });
}

// ── Customer: accept + deposit ──────────────────────────────────────────────
export type AcceptResult = { event_booking_id: string; status: string; payment: { id: string; checkout_url: string; amount_minor: number; simulation: boolean } };

export async function acceptQuote(tenantId: string, user: SessionUser, id: string, input: { quoteVersion: number; idempotencyKey: string; returnUrl: string; actor: AuditActor }) {
  return withTenant(tenantId, (trx) => idempotent(trx, { scope: `tenant:${tenantId}:user:${user.userId}`, operation: 'event.accept', key: input.idempotencyKey, hash: requestHash({ id, v: input.quoteVersion }) }, async (): Promise<{ status: number; body: AcceptResult }> => {
    const locked = await lockEvent(trx, id);
    if (!locked || locked.customer_user_id !== user.userId) throw Errors.notFound('event_booking');
    const e = await settleTimeouts(trx, locked);
    if (e.status === 'expired') throw Errors.conflict('quote_expired', 'This quote has expired. Ask the business for a new one.');
    if (e.status !== 'quoted') throw Errors.conflict('invalid_transition', `Event booking is ${e.status}`);
    // The customer accepts exactly the quote she saw; a revised quote must be reviewed first.
    if (e.quote_version !== input.quoteVersion) throw Errors.conflict('quote_changed', 'The quote was updated. Please review it again.', { quote_version: e.quote_version });
    const occ = occupied(e);
    const paymentExpires = new Date(Math.min(Date.now() + EVENT_PAYMENT_TTL_MIN * 60_000, e.quote_expires_at!.getTime()));
    await releaseExpiredHolds(trx, [e.staff_id!], []);
    await sql`savepoint event_hold`.execute(trx);
    try {
      await trx.insertInto('booking_allocations').values({ tenant_id: tenantId, event_booking_id: e.id, staff_id: e.staff_id!, during: occ.range, state: 'held', expires_at: paymentExpires }).execute();
      await sql`release savepoint event_hold`.execute(trx);
    } catch (err) {
      await sql`rollback to savepoint event_hold`.execute(trx);
      if (isPgCode(err, '23P01')) throw new AppError(409, 'slot_unavailable', 'This time is no longer available. Please contact the business.');
      throw err;
    }
    const pay = await createEventCheckout(trx, {
      tenantId, eventBookingId: e.id, kind: 'deposit', amountMinor: e.deposit_minor!, currency: e.currency, payerUserId: user.userId,
      idempotencyKey: input.idempotencyKey, description: `Event deposit ${e.number}`, returnUrl: input.returnUrl, expiresAt: paymentExpires,
    });
    await trx.updateTable('event_bookings').set({ status: 'pending_payment', accepted_at: new Date(), payment_expires_at: paymentExpires, version: sql`version + 1` }).where('id', '=', e.id).execute();
    await audit(trx, input.actor, 'event.accepted', { tenantId, targetType: 'event_booking', targetId: e.id, data: { payment_id: pay.id, deposit_minor: e.deposit_minor, quote_version: e.quote_version } });
    return { status: 201, body: { event_booking_id: e.id, status: 'pending_payment', payment: { id: pay.id, checkout_url: pay.checkoutUrl, amount_minor: e.deposit_minor!, simulation: pay.simulation } } };
  }));
}

// ── Payment target handlers (wired in src/server/boot.ts) ───────────────────
/** A captured deposit confirms the event and turns the held time into a confirmed reservation. */
export async function onEventPaymentCaptured(trx: Tx, tenantId: string, eventId: string, payment: { paymentId: string; amountMinor: number }): Promise<{ refund?: string }> {
  const e = await lockEvent(trx, eventId);
  if (!e) return { refund: 'event_missing' };
  const paid = e.paid_minor + payment.amountMinor;
  await trx.updateTable('event_bookings').set({ paid_minor: paid }).where('id', '=', e.id).execute();
  if (['confirmed', 'completed'].includes(e.status)) return {};
  if (['cancelled', 'declined'].includes(e.status)) return { refund: 'captured_after_event_closed' };
  // pending_payment, or a late capture after the checkout window lapsed (quoted/expired): keep the
  // event only if the exact time is still free.
  const confirmed = await trx.updateTable('booking_allocations').set({ state: 'confirmed', expires_at: null })
    .where('event_booking_id', '=', e.id).where('state', '=', 'held').returning('id').execute();
  if (!confirmed.length) {
    if (!e.staff_id || !e.ends_at) return { refund: 'event_not_quoted' };
    await releaseExpiredHolds(trx, [e.staff_id], []);
    await sql`savepoint event_late`.execute(trx);
    try {
      await trx.insertInto('booking_allocations').values({ tenant_id: tenantId, event_booking_id: e.id, staff_id: e.staff_id, during: occupied(e).range, state: 'confirmed' }).execute();
      await sql`release savepoint event_late`.execute(trx);
    } catch (err) {
      await sql`rollback to savepoint event_late`.execute(trx);
      if (!isPgCode(err, '23P01')) throw err;
      await trx.updateTable('event_bookings').set({ status: 'cancelled', cancelled_at: new Date(), cancel_source: 'system', cancel_reason: 'payment_after_hold_expired_slot_taken', version: sql`version + 1` }).where('id', '=', e.id).execute();
      await notifyUsers(trx, tenantId, [e.customer_user_id], {
        kind: 'event.refunding', title_ar: 'انتهت مهلة الحجز قبل اكتمال الدفع — سيتم استرداد المبلغ', title_en: 'Your hold expired before payment completed — a refund is being issued',
        target_path: `/s/${await tenantSlug(trx, tenantId)}/events/${e.id}`,
      });
      return { refund: 'late_success_slot_taken' };
    }
  }
  await trx.updateTable('event_bookings').set({ status: 'confirmed', confirmed_at: new Date(), payment_expires_at: null, version: sql`version + 1` }).where('id', '=', e.id).execute();
  const slug = await tenantSlug(trx, tenantId);
  await notifyUsers(trx, tenantId, [e.customer_user_id], {
    kind: 'event.confirmed', title_ar: `تم تأكيد حجز مناسبتكِ ${e.number}`, title_en: `Your event booking ${e.number} is confirmed`,
    body_ar: 'استلمنا العربون، والمبلغ المتبقي يُدفع يوم المناسبة.', body_en: 'Deposit received. The balance is due on the day.',
    target_path: `/s/${slug}/events/${e.id}`, dedupe_key: `event.confirmed:${e.id}`,
  });
  await notifyCapability(trx, tenantId, ['bookings.manage'], {
    kind: 'event.confirmed', title_ar: `تم دفع عربون المناسبة ${e.number}`, title_en: `Deposit paid for event ${e.number}`,
    target_path: `/app/${slug}/events?id=${e.id}`, dedupe_key: `event.deposit_paid:${e.id}`,
  });
  return {};
}

/** A failed / cancelled checkout frees the held time; the customer may accept again while the quote is valid. */
export async function onEventPaymentFailed(trx: Tx, _tenantId: string, eventId: string) {
  const e = await lockEvent(trx, eventId);
  if (!e || e.status !== 'pending_payment') return;
  await releaseAllocations(trx, e.id);
  const status: EventStatus = e.quote_expires_at && e.quote_expires_at > new Date() ? 'quoted' : 'expired';
  await trx.updateTable('event_bookings').set({ status, payment_expires_at: null, version: sql`version + 1` }).where('id', '=', e.id).execute();
}

export async function onEventRefunded(trx: Tx, _tenantId: string, eventId: string, refund: { amountMinor: number }) {
  const e = await trx.updateTable('event_bookings').set({ refunded_minor: sql`refunded_minor + ${refund.amountMinor}` }).where('id', '=', eventId).returning('status').executeTakeFirstOrThrow();
  return { completed: e.status === 'completed' };
}

// ── Cancellation ────────────────────────────────────────────────────────────
type CancelActor = { kind: 'customer'; userId: string; audit: AuditActor } | { kind: 'business'; access: TenantAccess; audit: AuditActor };

export async function cancelEvent(tenantId: string, id: string, actor: CancelActor, reason: string, now = new Date()) {
  return withTenant(tenantId, async (trx) => {
    const locked = await lockEvent(trx, id);
    if (!locked || (actor.kind === 'customer' && locked.customer_user_id !== actor.userId)) throw Errors.notFound('event_booking');
    const e = await settleTimeouts(trx, locked, now);
    if (!['requested', 'quoted', 'pending_payment', 'confirmed'].includes(e.status)) throw Errors.conflict('invalid_transition', `Event booking is ${e.status}`);
    if (actor.kind === 'customer' && e.starts_at <= now) throw Errors.conflict('event_started', 'The event has already started. Please contact the business.');
    const snap = e.policy_snapshot as Snapshot;
    const outcome = eventCancellationRefund({
      by: actor.kind, paidMinor: e.paid_minor, refundedMinor: e.refunded_minor, depositMinor: e.deposit_minor ?? 0,
      startsAt: e.starts_at, now, freeCancellationDays: snap.free_cancellation_days ?? 0,
    });
    await releaseAllocations(trx, e.id);
    await trx.updateTable('payments').set({ status: 'cancelled' }).where('event_booking_id', '=', e.id).where('status', 'in', ['pending', 'requires_action']).execute();
    const row = await trx.updateTable('event_bookings').set({
      status: 'cancelled', cancelled_at: now, cancel_source: actor.kind, cancel_reason: reason, payment_expires_at: null, version: sql`version + 1`,
    }).where('id', '=', e.id).returningAll().executeTakeFirstOrThrow();
    let refunded = 0;
    if (outcome.refundMinor > 0) refunded = await refundEventDue(trx, tenantId, e.id, outcome.refundMinor, outcome.basis);
    if (outcome.retainedMinor > 0) {
      // The retained deposit is earned under the cancellation policy.
      await post(trx, tenantId, { type: 'event_retained', id: e.id }, [
        { account: 'customer_deposits', debit: outcome.retainedMinor }, { account: 'service_revenue', credit: outcome.retainedMinor },
      ], { memo: `retained per event policy ${e.number}` });
    }
    const slug = await tenantSlug(trx, tenantId);
    if (actor.kind === 'customer') {
      await notifyCapability(trx, tenantId, ['bookings.manage'], {
        kind: 'event.cancelled', title_ar: `ألغت العميلة حجز المناسبة ${e.number}`, title_en: `The customer cancelled event ${e.number}`,
        body_ar: reason, body_en: reason, target_path: `/app/${slug}/events?id=${e.id}`,
      });
    } else {
      await notifyUsers(trx, tenantId, [e.customer_user_id], {
        kind: 'event.cancelled', title_ar: `تم إلغاء حجز مناسبتكِ ${e.number}`, title_en: `Your event booking ${e.number} was cancelled`,
        body_ar: refunded > 0 ? 'سيتم استرداد المبلغ المدفوع بالكامل.' : reason, body_en: refunded > 0 ? 'Everything you paid will be refunded.' : reason,
        target_path: `/s/${slug}/events/${e.id}`,
      });
    }
    await audit(trx, actor.audit, 'event.cancelled', { tenantId, targetType: 'event_booking', targetId: e.id, data: { by: actor.kind, reason, refund_minor: refunded, retained_minor: outcome.retainedMinor, basis: outcome.basis } });
    return { ...row, refund_minor: refunded, retained_minor: outcome.retainedMinor, basis: outcome.basis };
  });
}

// ── On the day: balance and completion ─────────────────────────────────────
export async function recordEventBalance(access: TenantAccess, actor: AuditActor, id: string, input: { amountMinor: number; method: 'cash' | 'pos_terminal'; reference: string; idempotencyKey: string }) {
  if (!actor.userId) throw Errors.unauthenticated();
  return withTenant(access.tenantId, (trx) => idempotent(trx, { scope: `tenant:${access.tenantId}`, operation: 'event.balance', key: input.idempotencyKey, hash: requestHash({ id, ...input }) }, async () => {
    const e = await lockEvent(trx, id);
    if (!e) throw Errors.notFound('event_booking');
    if (!['confirmed', 'completed'].includes(e.status)) throw Errors.conflict('invalid_transition', `Event booking is ${e.status}`);
    const due = (e.total_minor ?? 0) - e.paid_minor;
    if (input.amountMinor > due) throw Errors.invalid('amount_exceeds_due', 'Amount exceeds the balance due', { due_minor: due });
    const p = await trx.insertInto('payments').values({
      tenant_id: access.tenantId, purpose: 'event', event_booking_id: e.id, kind: 'balance', method: input.method, amount_minor: input.amountMinor, currency: e.currency,
      status: 'captured', provider: 'on_site', idempotency_key: `event-onsite:${input.idempotencyKey}`, collected_by: actor.userId, cash_reference: input.reference,
      captured_at: new Date(), created_by: actor.userId,
    }).returning('id').executeTakeFirstOrThrow();
    await applyCapturedPayment(trx, access.tenantId, p.id, actor.userId);
    await audit(trx, actor, 'event.balance_collected', { tenantId: access.tenantId, targetType: 'event_booking', targetId: e.id, data: { payment_id: p.id, amount_minor: input.amountMinor, method: input.method, reference: input.reference } });
    return { status: 201, body: { payment_id: p.id, balance_due_minor: due - input.amountMinor } };
  }));
}

export async function completeEvent(access: TenantAccess, actor: AuditActor, id: string, now = new Date()) {
  return withTenant(access.tenantId, async (trx) => {
    const e = await lockEvent(trx, id);
    if (!e) throw Errors.notFound('event_booking');
    if (e.status !== 'confirmed') throw Errors.conflict('invalid_transition', `Event booking is ${e.status}`);
    if (e.starts_at > now) throw Errors.conflict('not_started', 'The event has not started yet');
    const total = e.total_minor ?? 0;
    const tax = e.tax_minor ?? 0;
    const prepaid = Math.min(total, e.paid_minor - e.refunded_minor);
    // Prepaid money moves from deposits to revenue; any unpaid part becomes a receivable.
    await post(trx, access.tenantId, { type: 'event_completion', id: e.id }, [
      { account: 'customer_deposits', debit: prepaid }, { account: 'accounts_receivable', debit: total - prepaid },
      { account: 'service_revenue', credit: total - tax }, { account: 'tax_payable', credit: tax },
    ], { createdBy: actor.userId, memo: `event ${e.number}` });
    const row = await trx.updateTable('event_bookings').set({ status: 'completed', completed_at: now, version: sql`version + 1` }).where('id', '=', e.id).returningAll().executeTakeFirstOrThrow();
    await audit(trx, actor, 'event.completed', { tenantId: access.tenantId, targetType: 'event_booking', targetId: e.id });
    return row;
  });
}

/** Public storefront summary (no customer data): is the request form available? */
export async function publicEventInfo(trx: Tx, tenantId: string) {
  const s = await getEventSettings(trx, tenantId);
  return { enabled: s.enabled, max_people: s.max_people, free_cancellation_days: s.free_cancellation_days, intro_ar: s.intro_ar, intro_en: s.intro_en, default_deposit_bp: s.default_deposit_bp };
}
