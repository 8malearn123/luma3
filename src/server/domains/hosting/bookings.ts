import { sql } from 'kysely';
import type { Tx } from '../../db/client';
import { AppError, Errors, isPgCode } from '../../http/errors';
import { audit, type AuditActor } from '../../infra/audit';
import { idempotent, requestHash } from '../../infra/idempotency';
import { notifyCapability, notifyUsers } from '../../infra/notify';
import type { SessionUser } from '../../auth/service';
import type { TenantAccess } from '../../tenancy/access';
import { releaseExpiredHolds } from '../booking/service';
import { activeAccount, createWorkspaceCheckout, refundWorkspaceDue } from '../payments/service';
import { requestFits } from './availability';
import {
  availableUnits, bookingLines, extraWithTax, issueWorkspaceInvoice, postBookingPaid, postExtraCharge, postExtraPaid, postRefund,
  returnAddonStock, sellAddonStock, splitLines, statement, taxRuleFor, type LineRow,
} from './money';
import { asSystem, hostingTx, lockBooking, lockFor, newCheckInCode, newQrToken, nextWorkspaceNumber, recordEvent, type WsRow } from './scope';
import {
  APPROVAL_HOLD_MIN, PAYMENT_HOLD_MIN, WS_TRANSITIONS, canTransition, cancellationOutcome, lateFee, quote,
  type CancellationTerms, type LateTerms, type QuoteAddon, type RequestInput, type TaxRule, type WsAction, type WsActor, type WsStatus,
} from '@/shared/schemas/hosting';

/**
 * Workspace bookings — lifecycle (state machine in shared/schemas/hosting.ts):
 *
 *   request ─┬─ instant  → held ──checkout──→ pending_payment ──captured──→ confirmed
 *            └─ approval → pending_approval (2h, never beyond start; D1c)
 *                              ├─ host approves → held (payment window)
 *                              ├─ host rejects  → cancelled
 *                              └─ timeout       → expired
 *   confirmed → checked_in (code / QR) → in_use (at start) → completed (check-out; proposed late fee, D8)
 *   confirmed → cancelled (guest/host, saved terms) | no_show (host, after start + grace)
 *
 * Reservations are booking_allocations rows (host chair + equipment, guest
 * provider profile); the exclusion constraints decide every race.
 */

type Snapshot = {
  listing_id: string; code: string; title_ar: string | null; title_en: string | null; space_type: string;
  price_model: string; price_minor: number; period_min: number | null; addons_discount_bp: number;
  addons: Array<QuoteAddon>; tax: TaxRule & { label: string | null };
  cancellation_terms: CancellationTerms; late_terms: LateTerms;
  access_instructions_ar: string | null; access_instructions_en: string | null; usage_rules_ar: string | null; usage_rules_en: string | null;
  own_materials_policy_ar: string | null; own_materials_policy_en: string | null;
  setup_buffer_min: number; cleanup_buffer_min: number; terms_version: number; captured_at: string;
  quote: { rent_minor: number; addons_minor: number; discount_minor: number; tax_minor: number; total_minor: number; base_total_minor: number };
};

const MIN = 60_000;
const range = (s: number, e: number) => `[${new Date(s).toISOString()},${new Date(e).toISOString()})`;

function assertTransition(action: WsAction, w: { status: string }, by: WsActor) {
  if (!canTransition(action, w.status, by)) throw Errors.conflict('invalid_transition', `Space booking is ${w.status}`, { status: w.status, action });
}

async function setStatus(trx: Tx, w: NonNullable<WsRow>, action: WsAction, by: WsActor, userId: string | null, patch: Record<string, unknown> = {}, reason?: string | null) {
  const to = WS_TRANSITIONS[action].to as WsStatus;
  const row = await trx.updateTable('workspace_bookings').set({ ...patch, status: to, version: sql`version + 1` } as never).where('id', '=', w.id).returningAll().executeTakeFirstOrThrow();
  await recordEvent(trx, w, { from: w.status, to, actor: by, userId, reason: reason ?? action });
  return row;
}

async function releaseAll(trx: Tx, wbId: string) {
  await trx.updateTable('booking_allocations').set({ state: 'released', released_at: new Date() }).where('workspace_booking_id', '=', wbId).where('state', '<>', 'released').execute();
  // Her appointments placed inside this window revert to ordinary appointments (the link stays on the booking for display).
  await trx.updateTable('booking_allocations').set({ within_workspace_booking_id: null }).where('within_workspace_booking_id', '=', wbId).execute();
}

const hostPath = (slug: string, id: string) => `/app/${slug}/hosting?booking=${id}`;
const guestPath = (slug: string, id: string) => `/app/${slug}/workspace?booking=${id}`;

async function notifyHost(trx: Tx, w: { host_tenant_id: string; host_snapshot: unknown; id: string }, kind: string, ar: string, en: string) {
  const slug = (w.host_snapshot as { slug?: string }).slug ?? '';
  await notifyCapability(trx, w.host_tenant_id, ['hosting.manage'], { kind, title_ar: ar, title_en: en, target_path: hostPath(slug, w.id), data: { workspace_booking_id: w.id } });
}
async function notifyGuest(trx: Tx, w: { guest_tenant_id: string; guest_user_id: string; guest_snapshot: unknown; id: string }, kind: string, ar: string, en: string, body?: { ar: string; en: string }) {
  const slug = (w.guest_snapshot as { slug?: string }).slug ?? '';
  await notifyUsers(trx, w.guest_tenant_id, [w.guest_user_id], { kind, title_ar: ar, title_en: en, body_ar: body?.ar, body_en: body?.en, target_path: guestPath(slug, w.id), data: { workspace_booking_id: w.id } });
}

/**
 * Lazy timeouts, applied before every action (and by the periodic sweep):
 * an unanswered approval request or an unpaid hold expires and frees the chair;
 * a checked-in booking becomes in_use once its window starts.
 */
export async function settleTimeouts(trx: Tx, w: NonNullable<WsRow>, now = new Date()): Promise<NonNullable<WsRow>> {
  if (['pending_approval', 'held', 'pending_payment'].includes(w.status) && w.hold_expires_at && w.hold_expires_at <= now) {
    await releaseAll(trx, w.id);
    await trx.updateTable('payments').set({ status: 'expired' }).where('workspace_booking_id', '=', w.id).where('status', 'in', ['pending', 'requires_action']).execute();
    const row = await setStatus(trx, w, 'expire', 'system', null, { hold_expires_at: null, payment_status: w.paid_minor > 0 ? w.payment_status : 'unpaid' }, w.status === 'pending_approval' ? 'approval_timeout' : 'hold_expired');
    await notifyGuest(trx, w, 'workspace.expired', `انتهت مهلة طلب المساحة ${w.number}`, `Your space request ${w.number} expired`);
    return row;
  }
  if (w.status === 'checked_in' && now >= w.starts_at) return setStatus(trx, w, 'start_use', 'system', null);
  return w;
}

/** Periodic sweep (jobs.ts) and pre-allocation clean-up. */
export async function expireLapsed(trx: Tx, now = new Date(), filter: { resourceIds?: string[]; guestStaffId?: string } = {}) {
  let q = trx.selectFrom('workspace_bookings').select('id').where('status', 'in', ['pending_approval', 'held', 'pending_payment']).where('hold_expires_at', '<=', now);
  if (filter.resourceIds || filter.guestStaffId) {
    q = q.where((eb) => eb.or([
      ...(filter.resourceIds?.length ? [eb('resource_id', 'in', filter.resourceIds)] : []),
      ...(filter.guestStaffId ? [eb('guest_staff_id', '=', filter.guestStaffId)] : []),
    ]));
  }
  const rows = await q.limit(200).execute();
  for (const r of rows) await settleTimeouts(trx, await lockBooking(trx, r.id), now);
  return rows.length;
}

/** The expert's own provider profile in her workspace (owner_is_provider). */
async function guestStaffId(trx: Tx, access: TenantAccess) {
  if (access.staffProfileId) return access.staffProfileId;
  const s = await trx.selectFrom('staff_profiles').select('id').where('tenant_id', '=', access.tenantId).where('archived_at', 'is', null).where('is_active', '=', true)
    .orderBy('sort').orderBy('created_at').executeTakeFirst();
  if (!s) throw Errors.invalid('provider_profile_required', 'Your workspace needs a provider profile to book a space');
  return s.id;
}

// ── Request ─────────────────────────────────────────────────────────────────
export async function requestSpace(access: TenantAccess, user: SessionUser, actor: AuditActor, input: RequestInput, idempotencyKey: string, now = new Date()) {
  if (access.businessType !== 'expert') throw Errors.forbidden('Only independent experts can book spaces', { reason: 'experts_only' });
  const scope = `tenant:${access.tenantId}:hosting`;
  return hostingTx('expert requests a space at a host salon', (trx) => idempotent(trx, { scope, operation: 'workspace.request', key: idempotencyKey, hash: requestHash(input) }, async () => {
    const l = await trx.selectFrom('workspace_listings').selectAll().where('id', '=', input.listing_id).where('status', '=', 'published').executeTakeFirst();
    if (!l || l.tenant_id === access.tenantId) throw Errors.notFound('workspace_listing');
    const host = await trx.selectFrom('tenants').select(['id', 'name', 'slug', 'status']).where('id', '=', l.tenant_id).executeTakeFirstOrThrow();
    if (host.status !== 'active') throw Errors.notFound('workspace_listing');
    if (!(await activeAccount(trx, l.tenant_id))) throw Errors.unavailable('payments_unavailable', 'This salon cannot take payments right now');
    if (input.terms_version && input.terms_version !== l.terms_version) throw Errors.conflict('terms_changed', 'The space terms changed. Please review them again.', { terms_version: l.terms_version });

    const start = new Date(input.start);
    const end = new Date(start.getTime() + input.duration_min * MIN);
    if (start <= now) throw Errors.invalid('in_past', 'Choose a future time');
    if (start.getTime() > now.getTime() + 120 * 86_400_000) throw Errors.invalid('beyond_booking_window');
    if (input.duration_min < l.min_duration_min || input.duration_min > l.max_duration_min) {
      throw Errors.invalid('invalid_duration', 'Duration is outside what this space allows', { min: l.min_duration_min, max: l.max_duration_min });
    }
    const staffId = await guestStaffId(trx, access);
    const branch = await trx.selectFrom('branches').select(['id', 'name', 'address', 'city', 'latitude', 'longitude', 'timezone', 'phone']).where('id', '=', l.branch_id).executeTakeFirstOrThrow();

    // Add-ons: only from this listing; products at the CURRENT store price (frozen into the snapshot).
    const reqAddons = input.addons;
    if (new Set(reqAddons.map((a) => a.addon_id)).size !== reqAddons.length) throw Errors.invalid('invalid_addon', 'Duplicate add-on');
    const addonRows = reqAddons.length ? await trx.selectFrom('workspace_listing_addons as a').leftJoin('product_variants as v', 'v.id', 'a.product_variant_id').leftJoin('products as p', 'p.id', 'v.product_id')
      .select(['a.id', 'a.kind', 'a.product_variant_id', 'a.resource_id', 'a.name_ar', 'a.name_en', 'a.rental_price_minor', 'a.rental_unit', 'a.max_quantity', 'v.price_minor', 'v.is_active as v_active', 'p.status as p_status', 'p.name_ar as p_ar', 'p.name_en as p_en', 'v.name_ar as v_ar'])
      .where('a.tenant_id', '=', l.tenant_id).where('a.listing_id', '=', l.id).where('a.is_active', '=', true).where('a.id', 'in', reqAddons.map((a) => a.addon_id)).execute() : [];
    const addons: Array<QuoteAddon & { product_variant_id: string | null; resource_id: string | null }> = [];
    for (const ra of reqAddons) {
      const a = addonRows.find((x) => x.id === ra.addon_id);
      if (!a) throw Errors.invalid('invalid_addon', 'Unknown add-on', { addon_id: ra.addon_id });
      if (ra.quantity > a.max_quantity) throw Errors.invalid('addon_quantity', 'Quantity too high', { addon_id: a.id, max: a.max_quantity });
      if (a.kind === 'product') {
        if (!a.v_active || a.p_status !== 'active') throw Errors.invalid('addon_unavailable', 'This product is not available', { addon_id: a.id });
        if ((await availableUnits(trx, l.tenant_id, a.product_variant_id!, l.branch_id)) < ra.quantity) throw Errors.conflict('addon_out_of_stock', 'Not enough stock at the salon', { addon_id: a.id });
      }
      addons.push({
        addon_id: a.id, kind: a.kind as 'product' | 'equipment', quantity: ra.quantity,
        name: a.kind === 'product' ? [a.p_ar ?? a.p_en, a.v_ar].filter(Boolean).join(' · ') : (a.name_ar ?? a.name_en ?? 'equipment'),
        unit_price_minor: a.kind === 'product' ? a.price_minor! : a.rental_price_minor!, rental_unit: a.rental_unit as 'booking' | 'hour' | null,
        product_variant_id: a.product_variant_id, resource_id: a.resource_id,
      });
    }
    const tax = await taxRuleFor(trx, l.tenant_id);
    const q = quote({ price_model: l.price_model, price_minor: l.price_minor, period_min: l.period_min, addons_discount_bp: l.addons_discount_bp }, input.duration_min, addons, tax);
    const extraResources = [...new Set([...l.included_resource_ids, ...addons.filter((a) => a.resource_id).map((a) => a.resource_id!)])];

    // Free stale holds that could block this request, then check (advisory) and allocate (final).
    await expireLapsed(trx, now, { resourceIds: [l.resource_id, ...extraResources], guestStaffId: staffId });
    await releaseExpiredHolds(trx, [staffId], [l.resource_id, ...extraResources]);
    const fit = await requestFits(trx, l, start, end, extraResources, now);
    if (!fit.ok) throw Errors.conflict(fit.reason, 'This time is not available for this space');

    const snapshot: Snapshot = {
      listing_id: l.id, code: l.code, title_ar: l.title_ar, title_en: l.title_en, space_type: l.space_type, price_model: l.price_model, price_minor: l.price_minor,
      period_min: l.period_min, addons_discount_bp: l.addons_discount_bp, addons: addons.map(({ product_variant_id: _p, resource_id: _r, ...a }) => a), tax,
      cancellation_terms: l.cancellation_terms as CancellationTerms, late_terms: l.late_terms as LateTerms,
      access_instructions_ar: l.access_instructions_ar, access_instructions_en: l.access_instructions_en, usage_rules_ar: l.usage_rules_ar, usage_rules_en: l.usage_rules_en,
      own_materials_policy_ar: l.own_materials_policy_ar, own_materials_policy_en: l.own_materials_policy_en,
      setup_buffer_min: l.setup_buffer_min, cleanup_buffer_min: l.cleanup_buffer_min, terms_version: l.terms_version, captured_at: now.toISOString(),
      quote: { rent_minor: q.rent_minor, addons_minor: q.addons_minor, discount_minor: q.discount_minor, tax_minor: q.tax_minor, total_minor: q.total_minor, base_total_minor: q.base_total_minor },
    };
    const guest = await trx.selectFrom('tenants as t').leftJoin('staff_profiles as s', (j) => j.on('s.id', '=', staffId).onRef('s.tenant_id', '=', 't.id'))
      .select(['t.name', 't.slug', 's.display_name']).where('t.id', '=', access.tenantId).executeTakeFirstOrThrow();
    const holdMin = l.booking_mode === 'approval' ? APPROVAL_HOLD_MIN : PAYMENT_HOLD_MIN;
    const holdUntil = new Date(Math.min(now.getTime() + holdMin * MIN, start.getTime()));
    const number = await nextWorkspaceNumber(trx, l.tenant_id);
    const created = await trx.insertInto('workspace_bookings').values({
      host_tenant_id: l.tenant_id, guest_tenant_id: access.tenantId, number, listing_id: l.id, resource_id: l.resource_id, branch_id: l.branch_id,
      guest_staff_id: staffId, guest_user_id: user.userId, starts_at: start, ends_at: end, timezone: branch.timezone, occupied: range(fit.occ.start, fit.occ.end),
      status: 'requested', booking_mode: l.booking_mode, terms_snapshot: JSON.stringify(snapshot), listing_terms_version: l.terms_version, currency: l.currency,
      rent_minor: q.rent_minor, addons_minor: q.addons_minor, discount_minor: q.discount_minor, tax_minor: q.tax_minor, total_minor: q.total_minor,
      hold_expires_at: holdUntil, approval_deadline: l.booking_mode === 'approval' ? holdUntil : null,
      check_in_code: newCheckInCode(), qr_token: newQrToken(), guest_note: input.note ?? null,
      guest_snapshot: JSON.stringify({ name: guest.name, slug: guest.slug, provider_name: guest.display_name }),
      host_snapshot: JSON.stringify({ name: host.name, slug: host.slug, branch_name: branch.name, address: branch.address, city: branch.city, latitude: branch.latitude, longitude: branch.longitude, phone: branch.phone }),
    }).returningAll().executeTakeFirstOrThrow();
    await recordEvent(trx, created, { from: null, to: 'requested', actor: 'guest', userId: user.userId, reason: 'submitted' });

    // Journey 2: her client appointments (own tenant only) placed inside this window, linked atomically.
    for (const bookingId of [...new Set(input.link_booking_ids)]) await linkAppointment(trx, created, bookingId);

    // Final authority: exclusion constraints. Stable order (host resources, then guest staff) avoids deadlocks.
    try {
      for (const resourceId of [l.resource_id, ...extraResources.sort()]) {
        await trx.insertInto('booking_allocations').values({ tenant_id: l.tenant_id, workspace_booking_id: created.id, resource_id: resourceId, during: range(fit.occ.start, fit.occ.end), state: 'held', expires_at: holdUntil }).execute();
      }
      await trx.insertInto('booking_allocations').values({ tenant_id: access.tenantId, workspace_booking_id: created.id, staff_id: staffId, during: range(start.getTime(), end.getTime()), state: 'held', expires_at: holdUntil }).execute();
    } catch (e) {
      if (isPgCode(e, '23P01')) {
        const self = (e as { constraint?: string }).constraint?.startsWith('booking_allocations_staff');
        throw new AppError(409, self ? 'guest_busy' : 'slot_unavailable', self ? 'You already have a booking or appointment at this time' : 'This time is no longer available');
      }
      throw e;
    }

    await trx.insertInto('workspace_booking_lines').values(q.lines.map((x) => {
      const a = addons.find((y) => y.addon_id === x.addon_id);
      return {
        workspace_booking_id: created.id, host_tenant_id: l.tenant_id, guest_tenant_id: access.tenantId, kind: x.kind, status: 'approved', charge_group: 'booking',
        description: x.kind === 'rent' ? `Space ${l.code} — ${input.duration_min} min` : x.kind === 'discount' ? `Add-ons discount ${l.addons_discount_bp / 100}%` : x.kind === 'tax' ? (tax.label ?? 'Tax') : x.description,
        addon_id: x.addon_id ?? null, product_variant_id: a?.product_variant_id ?? null, resource_id: a?.resource_id ?? null,
        quantity: x.quantity, unit_price_minor: x.unit_price_minor, amount_minor: x.amount_minor, tax_included: !!x.tax_included, created_by: user.userId,
      };
    })).execute();

    const w = l.booking_mode === 'approval'
      ? await setStatus(trx, created, 'await_approval', 'system', null)
      : await setStatus(trx, created, 'hold', 'system', null);
    if (w.status === 'pending_approval') {
      await notifyHost(trx, w, 'workspace.requested', `طلب استضافة جديد ${number} — يحتاج ردًا خلال ساعتين`, `New space request ${number} — respond within 2 hours`);
    }
    await audit(trx, actor, 'workspace.requested', { tenantId: access.tenantId, targetType: 'workspace_booking', targetId: w.id, data: { number, listing_id: l.id, total_minor: q.total_minor } });
    await audit(trx, { ...actor, kind: 'system' }, 'hosting.request_received', { tenantId: l.tenant_id, targetType: 'workspace_booking', targetId: w.id, data: { number, mode: l.booking_mode } });
    return { status: 201, body: await guestView(trx, w) };
  }));
}

/** Places one of the guest's own appointments inside a space window (guest tenant only; never visible to the host, D14). */
async function linkAppointment(trx: Tx, w: { id: string; guest_tenant_id: string; guest_staff_id: string; starts_at: Date; ends_at: Date }, bookingId: string) {
  const b = await trx.selectFrom('bookings').select(['id', 'status']).where('tenant_id', '=', w.guest_tenant_id).where('id', '=', bookingId).executeTakeFirst();
  if (!b) throw Errors.notFound('booking');
  if (!['held', 'pending_payment', 'pending_approval', 'confirmed'].includes(b.status)) throw Errors.conflict('invalid_transition', `Booking is ${b.status}`);
  const allocs = await trx.selectFrom('booking_allocations').select(['id', 'staff_id', sql<Date>`lower(during)`.as('s'), sql<Date>`upper(during)`.as('e')])
    .where('tenant_id', '=', w.guest_tenant_id).where('booking_id', '=', b.id).where('state', '<>', 'released').where('staff_id', 'is not', null).execute();
  if (!allocs.length || allocs.some((a) => a.staff_id !== w.guest_staff_id)) throw Errors.invalid('workspace_staff_mismatch', 'Only your own appointments can be placed in this space');
  if (allocs.some((a) => a.s < w.starts_at || a.e > w.ends_at)) throw Errors.invalid('outside_workspace_window', 'The appointment must fit inside the space booking');
  await trx.updateTable('booking_allocations').set({ within_workspace_booking_id: w.id }).where('id', 'in', allocs.map((a) => a.id)).execute();
  await trx.updateTable('bookings').set({ workspace_booking_id: w.id }).where('tenant_id', '=', w.guest_tenant_id).where('id', '=', b.id).execute();
}

/** Applies lapsed timeouts in their own transaction, so an expiry sticks even when the caller's action is then refused. */
async function settleFirst(access: TenantAccess, id: string, side: 'host' | 'guest' | 'either', now: Date) {
  await hostingTx('apply lapsed space timeouts', async (trx) => {
    const { w } = await lockFor(trx, access, id, side);
    await settleTimeouts(trx, w, now);
  });
}

// ── Host decision (D1, D1c) ─────────────────────────────────────────────────
export async function decideRequest(access: TenantAccess, actor: AuditActor, id: string, input: { approve: boolean; note?: string }, now = new Date()) {
  await settleFirst(access, id, 'host', now);
  return hostingTx('host decides a space request', async (trx) => {
    const { w: locked } = await lockFor(trx, access, id, 'host');
    const w = await settleTimeouts(trx, locked, now);
    if (w.status === 'expired') throw Errors.conflict('request_expired', 'The 2-hour response window has passed; the request expired');
    if (!input.approve) {
      assertTransition('reject', w, 'host');
      const row = await cancelInternal(trx, w, { by: 'host', action: 'reject', reason: input.note || 'rejected', userId: actor.userId, now });
      await audit(trx, actor, 'hosting.request_rejected', { tenantId: access.tenantId, targetType: 'workspace_booking', targetId: w.id, data: { note: input.note ?? null } });
      return hostView(trx, row);
    }
    assertTransition('approve', w, 'host');
    const holdUntil = new Date(Math.min(now.getTime() + PAYMENT_HOLD_MIN * MIN, w.starts_at.getTime()));
    await trx.updateTable('booking_allocations').set({ expires_at: holdUntil }).where('workspace_booking_id', '=', w.id).where('state', '=', 'held').execute();
    const row = await setStatus(trx, w, 'approve', 'host', actor.userId, { hold_expires_at: holdUntil, approved_at: now, approved_by: actor.userId, host_note: input.note ?? w.host_note });
    await notifyGuest(trx, row, 'workspace.approved', `وافق الصالون على طلب المساحة ${w.number} — أكملي الدفع`, `Your space request ${w.number} was approved — complete payment`);
    await audit(trx, actor, 'hosting.request_approved', { tenantId: access.tenantId, targetType: 'workspace_booking', targetId: w.id });
    return hostView(trx, row);
  });
}

// ── Payment (D3b) ───────────────────────────────────────────────────────────
export async function checkoutSpace(access: TenantAccess, user: SessionUser, actor: AuditActor, id: string, input: { idempotencyKey: string; returnUrl: string }, now = new Date()) {
  await settleFirst(access, id, 'guest', now);
  return hostingTx('expert pays a space booking to the host salon', (trx) => idempotent(trx, { scope: `tenant:${access.tenantId}:hosting`, operation: 'workspace.checkout', key: input.idempotencyKey, hash: requestHash({ id }) }, async () => {
    const { w: locked } = await lockFor(trx, access, id, 'guest');
    const w = await settleTimeouts(trx, locked, now);
    if (w.status === 'expired') throw Errors.conflict('hold_expired', 'The reserved time expired. Please request the space again.');
    assertTransition('checkout', w, 'guest');
    const amount = w.total_minor - w.paid_minor;
    const pay = await createWorkspaceCheckout(trx, {
      hostTenantId: w.host_tenant_id, workspaceBookingId: w.id, payerTenantId: w.guest_tenant_id, kind: 'full', amountMinor: amount, currency: w.currency,
      payerUserId: user.userId, idempotencyKey: input.idempotencyKey, description: `Space booking ${w.number}`, returnUrl: input.returnUrl, expiresAt: w.hold_expires_at,
    });
    await setStatus(trx, w, 'checkout', 'guest', user.userId, { payment_status: 'pending' });
    await audit(trx, actor, 'workspace.checkout_created', { tenantId: access.tenantId, targetType: 'workspace_booking', targetId: w.id, data: { payment_id: pay.id, amount_minor: amount } });
    return { status: 201, body: { workspace_booking_id: w.id, status: 'pending_payment', payment: { id: pay.id, checkout_url: pay.checkoutUrl, amount_minor: amount, simulation: pay.simulation } } };
  }));
}

/** Outstanding approved extra charges (late fees, materials, corrections) → one checkout. */
export async function payDues(access: TenantAccess, user: SessionUser, actor: AuditActor, id: string, input: { idempotencyKey: string; returnUrl: string }) {
  return hostingTx('expert pays space dues to the host salon', (trx) => idempotent(trx, { scope: `tenant:${access.tenantId}:hosting`, operation: 'workspace.dues', key: input.idempotencyKey, hash: requestHash({ id }) }, async () => {
    const { w } = await lockFor(trx, access, id, 'guest');
    const lines = (await bookingLines(trx, w.id)).filter((l) => l.charge_group === 'extra' && l.status === 'approved' && !l.payment_id);
    const due = splitLines(lines).total;
    if (due <= 0) throw Errors.conflict('nothing_due', 'Nothing is due on this booking');
    const pay = await createWorkspaceCheckout(trx, {
      hostTenantId: w.host_tenant_id, workspaceBookingId: w.id, payerTenantId: w.guest_tenant_id, kind: 'balance', amountMinor: due, currency: w.currency,
      payerUserId: user.userId, idempotencyKey: input.idempotencyKey, description: `Space dues ${w.number}`, returnUrl: input.returnUrl, expiresAt: null,
    });
    await audit(trx, actor, 'workspace.dues_checkout_created', { tenantId: access.tenantId, targetType: 'workspace_booking', targetId: w.id, data: { payment_id: pay.id, amount_minor: due } });
    return { status: 201, body: { workspace_booking_id: w.id, payment: { id: pay.id, checkout_url: pay.checkoutUrl, amount_minor: due, simulation: pay.simulation } } };
  }));
}

/** Payment target (wired in boot.ts): runs inside the host-tenant webhook transaction. */
export async function onWorkspacePaymentCaptured(trx: Tx, hostTenantId: string, wbId: string, payment: { paymentId: string; amountMinor: number }): Promise<{ refund?: string }> {
  return asSystem(trx, 'workspace payment captured: confirm both tenants atomically', async () => {
    const w = await lockBooking(trx, wbId);
    if (w.host_tenant_id !== hostTenantId) return { refund: 'workspace_tenant_mismatch' };
    const paid = w.paid_minor + payment.amountMinor;
    await trx.updateTable('workspace_bookings').set({ paid_minor: paid }).where('id', '=', w.id).execute();
    const p = await trx.selectFrom('payments').select(['created_at']).where('id', '=', payment.paymentId).executeTakeFirstOrThrow();

    if (['confirmed', 'checked_in', 'in_use', 'completed', 'no_show'].includes(w.status) && w.payment_status !== 'pending') {
      // Dues payment for extra charges approved after the booking was paid.
      const lines = (await bookingLines(trx, w.id)).filter((l) => l.charge_group === 'extra' && l.status === 'approved' && !l.payment_id && l.created_at <= p.created_at);
      if (lines.length) await trx.updateTable('workspace_booking_lines').set({ payment_id: payment.paymentId }).where('id', 'in', lines.map((l) => l.id)).execute();
      await postExtraPaid(trx, w, payment.paymentId, payment.amountMinor);
      if (lines.length) await issueWorkspaceInvoice(trx, w, payment.paymentId, lines.map((l) => ({ ...l, payment_id: payment.paymentId })));
      await refreshSettlement(trx, w.id);
      return {};
    }
    if (['confirmed', 'checked_in', 'in_use', 'completed'].includes(w.status)) return {};
    if (w.status === 'cancelled' || w.status === 'no_show') return { refund: 'captured_after_space_closed' };

    // held / pending_payment / expired: confirm only if every reservation still stands (or can be re-taken).
    const allocs = await trx.selectFrom('booking_allocations').select(['id', 'tenant_id', 'staff_id', 'resource_id', 'state', 'expires_at', sql<Date>`lower(during)`.as('s'), sql<Date>`upper(during)`.as('e')])
      .where('workspace_booking_id', '=', w.id).execute();
    const now = new Date();
    const intact = allocs.length > 0 && allocs.every((a) => a.state === 'confirmed' || (a.state === 'held' && a.expires_at! > now));
    if (intact) {
      await trx.updateTable('booking_allocations').set({ state: 'confirmed', expires_at: null }).where('workspace_booking_id', '=', w.id).where('state', '=', 'held').execute();
    } else {
      const wanted = new Map<string, typeof allocs[number]>();
      for (const a of allocs) wanted.set(`${a.tenant_id}:${a.staff_id ?? a.resource_id}`, a);
      await sql`savepoint ws_late`.execute(trx);
      try {
        await trx.updateTable('booking_allocations').set({ state: 'released', released_at: now }).where('workspace_booking_id', '=', w.id).where('state', '<>', 'released').execute();
        for (const a of [...wanted.values()].sort((x, y) => (x.resource_id ? 0 : 1) - (y.resource_id ? 0 : 1))) {
          await trx.insertInto('booking_allocations').values({ tenant_id: a.tenant_id, workspace_booking_id: w.id, staff_id: a.staff_id, resource_id: a.resource_id, during: range(a.s.getTime(), a.e.getTime()), state: 'confirmed' }).execute();
        }
        await sql`release savepoint ws_late`.execute(trx);
      } catch (e) {
        await sql`rollback to savepoint ws_late`.execute(trx);
        if (!isPgCode(e, '23P01')) throw e;
        await releaseAll(trx, w.id);
        await setStatus(trx, w, 'cancel', 'system', null, { cancelled_at: now, cancel_source: 'system', cancel_reason: 'payment_after_hold_expired_slot_taken', hold_expires_at: null });
        await notifyGuest(trx, w, 'workspace.refunding', 'انتهت مهلة الحجز قبل اكتمال الدفع — سيتم استرداد المبلغ', 'Your hold expired before payment completed — a refund is being issued');
        return { refund: 'late_success_slot_taken' };
      }
    }
    const fromStatus = w.status as WsStatus;
    const row = await trx.updateTable('workspace_bookings').set({ status: 'confirmed', confirmed_at: now, hold_expires_at: null, payment_status: 'paid', version: sql`version + 1` })
      .where('id', '=', w.id).returningAll().executeTakeFirstOrThrow();
    await recordEvent(trx, w, { from: fromStatus, to: 'confirmed', actor: 'system', reason: 'payment_captured', data: { payment_id: payment.paymentId } });

    const lines = (await bookingLines(trx, w.id)).filter((l) => l.charge_group === 'booking' && l.status === 'approved');
    await trx.updateTable('workspace_booking_lines').set({ payment_id: payment.paymentId }).where('id', 'in', lines.map((l) => l.id)).execute();
    await postBookingPaid(trx, w, payment.paymentId, lines, null);
    // Products are handed over with the booking: one sale movement per line at store price (D5); the cost is captured now.
    for (const l of lines.filter((x) => x.kind === 'product')) await deliverProduct(trx, w, l, null);
    await issueWorkspaceInvoice(trx, w, payment.paymentId, (await bookingLines(trx, w.id)).filter((l) => l.payment_id === payment.paymentId));
    await notifyGuest(trx, row, 'workspace.confirmed', `تم تأكيد حجز المساحة ${w.number}`, `Your space booking ${w.number} is confirmed`,
      { ar: 'تجدين تعليمات الوصول ورمز الدخول في تفاصيل الحجز.', en: 'Access instructions and your check-in QR are in the booking details.' });
    await notifyHost(trx, row, 'workspace.confirmed', `تم دفع حجز المساحة ${w.number}`, `Space booking ${w.number} was paid`);
    return {};
  });
}

/** Sale movement for one product line; a line that cannot be fulfilled is voided and its share refunded. */
async function deliverProduct(trx: Tx, w: NonNullable<WsRow>, l: LineRow, actorUserId: string | null) {
  const sold = await sellAddonStock(trx, w.host_tenant_id, { id: l.id, product_variant_id: l.product_variant_id!, quantity: Number(l.quantity), branch_id: w.branch_id }, actorUserId);
  if (!sold) {
    await trx.updateTable('workspace_booking_lines').set({ status: 'void', decision_note: 'out_of_stock_at_handover' }).where('id', '=', l.id).execute();
    const snap = w.terms_snapshot as Snapshot;
    const net = Math.round((l.amount_minor * (10000 - snap.addons_discount_bp)) / 10000);
    const share = snap.tax.prices_include_tax ? net : extraWithTax(net, snap.tax).total;
    if (share > 0) await refundWorkspaceDue(trx, w.host_tenant_id, w.id, share, `product_unavailable:${l.id}`);
    return null;
  }
  await trx.updateTable('workspace_booking_lines').set({ inventory_item_id: sold.itemId, unit_cost_minor: sold.unitCostMinor, stock_moved_at: new Date() }).where('id', '=', l.id).execute();
  return sold;
}

export async function onWorkspacePaymentFailed(trx: Tx, _hostTenantId: string, wbId: string) {
  await asSystem(trx, 'workspace payment failed: free the checkout', async () => {
    const w = await lockBooking(trx, wbId);
    if (w.status !== 'pending_payment') return;
    const now = new Date();
    if (w.hold_expires_at && w.hold_expires_at > now) await setStatus(trx, w, 'payment_failed', 'system', null, { payment_status: 'unpaid' });
    else await settleTimeouts(trx, w, now);
  });
}

export async function onWorkspaceRefunded(trx: Tx, _hostTenantId: string, wbId: string, refund: { refundId: string; amountMinor: number }) {
  return asSystem(trx, 'workspace refund succeeded: update both ledgers', async () => {
    const w = await lockBooking(trx, wbId);
    const refunded = w.refunded_minor + refund.amountMinor;
    await trx.updateTable('workspace_bookings').set({ refunded_minor: refunded, payment_status: refunded >= w.paid_minor ? 'refunded' : 'partially_refunded' }).where('id', '=', w.id).execute();
    await postRefund(trx, w, refund.refundId, refund.amountMinor, (w.terms_snapshot as Snapshot).tax);
    await refreshSettlement(trx, w.id);
  });
}

// ── Cancellation / no-show (D10: never touches her client appointments' status) ──
async function cancelInternal(trx: Tx, w: NonNullable<WsRow>, o: { by: 'guest' | 'host' | 'system'; action: 'cancel' | 'reject' | 'no_show'; reason: string; userId: string | null; now: Date }) {
  await releaseAll(trx, w.id);
  await trx.updateTable('payments').set({ status: 'cancelled' }).where('workspace_booking_id', '=', w.id).where('status', 'in', ['pending', 'requires_action']).execute();
  const snap = w.terms_snapshot as Snapshot;
  const paid = w.paid_minor - w.refunded_minor;
  const outcome = cancellationOutcome({ by: o.action === 'no_show' ? 'guest' : o.by, terms: snap.cancellation_terms, paidMinor: paid, rentGrossMinor: w.rent_minor, startsAt: w.starts_at, now: o.action === 'no_show' ? w.starts_at : o.now });
  const lines = await bookingLines(trx, w.id);
  for (const l of lines.filter((x) => x.kind === 'product' && x.stock_moved_at && !x.stock_returned_at && x.inventory_item_id)) {
    await returnAddonStock(trx, w.host_tenant_id, { id: l.id, inventory_item_id: l.inventory_item_id!, quantity: Number(l.quantity) }, o.userId);
    await trx.updateTable('workspace_booking_lines').set({ stock_returned_at: o.now }).where('id', '=', l.id).execute();
  }
  await trx.updateTable('workspace_booking_lines').set({ status: 'void' }).where('workspace_booking_id', '=', w.id).where('status', 'in', ['approved', 'proposed']).execute();
  if (outcome.feeMinor > 0) {
    const lastPay = lines.find((l) => l.payment_id)?.payment_id ?? null;
    await trx.insertInto('workspace_booking_lines').values({
      workspace_booking_id: w.id, host_tenant_id: w.host_tenant_id, guest_tenant_id: w.guest_tenant_id, kind: 'correction', status: 'approved', charge_group: 'booking',
      description: o.action === 'no_show' ? 'No-show fee (saved terms)' : 'Late cancellation fee (saved terms)', quantity: 1, unit_price_minor: outcome.feeMinor, amount_minor: outcome.feeMinor,
      payment_id: lastPay, created_by: o.userId,
    }).execute();
  }
  const row = await setStatus(trx, w, o.action === 'no_show' ? 'no_show' : o.action === 'reject' ? 'reject' : 'cancel', o.by, o.userId,
    { cancelled_at: o.now, cancel_source: o.by, cancel_reason: o.reason, hold_expires_at: null, payment_status: paid > 0 ? w.payment_status : 'unpaid' }, o.reason);
  if (outcome.refundMinor > 0) await refundWorkspaceDue(trx, w.host_tenant_id, w.id, outcome.refundMinor, outcome.basis);
  if (o.by === 'host') await notifyGuest(trx, row, 'workspace.cancelled', `ألغى الصالون حجز المساحة ${w.number}`, `The salon cancelled space booking ${w.number}`, { ar: o.reason, en: o.reason });
  else await notifyHost(trx, row, 'workspace.cancelled', `أُلغي حجز المساحة ${w.number}`, `Space booking ${w.number} was cancelled`);
  return row;
}

export async function cancelSpace(access: TenantAccess, actor: AuditActor, id: string, reason: string, now = new Date()) {
  await settleFirst(access, id, 'either', now);
  return hostingTx('cancel a space booking under its saved terms', async (trx) => {
    const { w: locked, as } = await lockFor(trx, access, id, 'either');
    const w = await settleTimeouts(trx, locked, now);
    assertTransition('cancel', w, as);
    if (as === 'guest' && w.status === 'confirmed' && now >= w.starts_at) throw Errors.conflict('space_started', 'The booking has started; contact the salon');
    const row = await cancelInternal(trx, w, { by: as, action: 'cancel', reason, userId: actor.userId, now });
    await audit(trx, actor, 'workspace.cancelled', { tenantId: access.tenantId, targetType: 'workspace_booking', targetId: w.id, data: { by: as, reason } });
    return as === 'host' ? hostView(trx, row) : guestView(trx, row);
  });
}

export async function markNoShow(access: TenantAccess, actor: AuditActor, id: string, now = new Date()) {
  return hostingTx('host marks a space no-show', async (trx) => {
    const { w } = await lockFor(trx, access, id, 'host');
    assertTransition('no_show', w, 'host');
    const grace = (w.terms_snapshot as Snapshot).late_terms.grace_min;
    if (now.getTime() < w.starts_at.getTime() + grace * MIN) throw Errors.conflict('too_early', 'A no-show can be recorded after the start plus the grace period');
    const row = await cancelInternal(trx, w, { by: 'host', action: 'no_show', reason: 'no_show', userId: actor.userId, now });
    await audit(trx, actor, 'hosting.no_show', { tenantId: access.tenantId, targetType: 'workspace_booking', targetId: w.id });
    return hostView(trx, row);
  });
}

// ── Check-in / check-out (D8) ───────────────────────────────────────────────
async function doCheck(trx: Tx, w: NonNullable<WsRow>, action: 'in' | 'out', by: 'guest' | 'host', userId: string | null, now: Date) {
  if (action === 'in') {
    assertTransition('check_in', w, by);
    if (now.getTime() < w.starts_at.getTime() - 60 * MIN || now >= w.ends_at) throw Errors.conflict('outside_check_in_window', 'Check-in opens one hour before the start');
    let row = await setStatus(trx, w, 'check_in', by, userId, { checked_in_at: now, checked_in_by: userId });
    if (now >= w.starts_at) row = await setStatus(trx, row, 'start_use', 'system', null);
    return row;
  }
  const cur = await settleTimeouts(trx, w, now);
  assertTransition('check_out', cur, by);
  const snap = cur.terms_snapshot as Snapshot;
  const over = Math.floor((now.getTime() - cur.ends_at.getTime()) / MIN);
  const fee = lateFee(snap.late_terms, over);
  if (fee > 0) {
    // D8: declared in the terms, PROPOSED here; it enters the settlement only once the salon approves it.
    await trx.insertInto('workspace_booking_lines').values({
      workspace_booking_id: cur.id, host_tenant_id: cur.host_tenant_id, guest_tenant_id: cur.guest_tenant_id, kind: 'late_fee', status: 'proposed', charge_group: 'extra',
      description: `Late check-out: ${over} min (grace ${snap.late_terms.grace_min} min)`, quantity: 1, unit_price_minor: fee, amount_minor: fee, created_by: userId,
    }).execute();
  }
  const row = await setStatus(trx, cur, 'check_out', by, userId, { checked_out_at: now, checked_out_by: userId, completed_at: now });
  if (fee > 0) await notifyHost(trx, row, 'workspace.late_fee_proposed', `رسوم تأخير مقترحة على ${cur.number} بانتظار اعتمادك`, `Proposed late fee on ${cur.number} awaits your approval`);
  return row;
}

/** Host: manual check-in/out of a booking. */
export async function hostCheck(access: TenantAccess, actor: AuditActor, id: string, action: 'in' | 'out', now = new Date()) {
  return hostingTx('host records space check-in/out', async (trx) => {
    const { w } = await lockFor(trx, access, id, 'host');
    const row = await doCheck(trx, w, action, 'host', actor.userId, now);
    await audit(trx, actor, `hosting.check_${action}`, { tenantId: access.tenantId, targetType: 'workspace_booking', targetId: w.id, data: { method: 'manual' } });
    return hostView(trx, row);
  });
}

/** Host: scans the expert's QR (check-in if confirmed, otherwise check-out). */
export async function scanQr(access: TenantAccess, actor: AuditActor, token: string, now = new Date()) {
  return hostingTx('host scans a space QR', async (trx) => {
    const found = await trx.selectFrom('workspace_bookings').select('id').where('qr_token', '=', token).where('host_tenant_id', '=', access.tenantId).executeTakeFirst();
    if (!found) throw Errors.notFound('workspace_booking');
    const w = await lockBooking(trx, found.id);
    const action = w.status === 'confirmed' ? 'in' : 'out';
    const row = await doCheck(trx, w, action, 'host', actor.userId, now);
    await audit(trx, actor, `hosting.check_${action}`, { tenantId: access.tenantId, targetType: 'workspace_booking', targetId: w.id, data: { method: 'qr' } });
    return hostView(trx, row);
  });
}

/** Guest: enters the code given at the salon reception. */
export async function guestCheck(access: TenantAccess, actor: AuditActor, id: string, action: 'in' | 'out', code: string, now = new Date()) {
  return hostingTx('expert records space check-in/out by code', async (trx) => {
    const { w } = await lockFor(trx, access, id, 'guest');
    if (code !== w.check_in_code) throw Errors.invalid('invalid_code', 'This code does not match');
    const row = await doCheck(trx, w, action, 'guest', actor.userId, now);
    await audit(trx, actor, `workspace.check_${action}`, { tenantId: access.tenantId, targetType: 'workspace_booking', targetId: w.id, data: { method: 'code' } });
    return guestView(trx, row);
  });
}

// ── Extra charges ───────────────────────────────────────────────────────────
async function refreshSettlement(trx: Tx, wbId: string) {
  const w = await trx.selectFrom('workspace_bookings').select(['id', 'settlement_status', 'paid_minor', 'refunded_minor', 'currency', 'status']).where('id', '=', wbId).executeTakeFirstOrThrow();
  if (!['approved', 'settled'].includes(w.settlement_status)) return;
  const s = await statement(trx, w);
  const next = s.due_from_guest_minor === 0 && s.credit_to_guest_minor === 0 ? 'settled' : 'approved';
  if (next !== w.settlement_status) await trx.updateTable('workspace_bookings').set({ settlement_status: next }).where('id', '=', w.id).execute();
}

async function markCorrected(trx: Tx, w: { id: string; settlement_status: string }) {
  if (['approved', 'settled'].includes(w.settlement_status)) await trx.updateTable('workspace_bookings').set({ settlement_status: 'corrected' }).where('id', '=', w.id).execute();
}

/** Host decides a proposed late fee (D8). */
export async function decideLateFee(access: TenantAccess, actor: AuditActor, id: string, lineId: string, input: { approve: boolean; note?: string }) {
  return hostingTx('host decides a proposed late fee', async (trx) => {
    const { w } = await lockFor(trx, access, id, 'host');
    const l = await trx.selectFrom('workspace_booking_lines').selectAll().where('id', '=', lineId).where('workspace_booking_id', '=', w.id).forUpdate().executeTakeFirst();
    if (!l || l.kind !== 'late_fee') throw Errors.notFound('late_fee');
    if (l.status !== 'proposed') throw Errors.conflict('already_decided');
    const now = new Date();
    await trx.updateTable('workspace_booking_lines').set({ status: input.approve ? 'approved' : 'rejected', decided_by: actor.userId, decided_at: now, decision_note: input.note ?? null }).where('id', '=', l.id).execute();
    if (input.approve) {
      const rule = (w.terms_snapshot as Snapshot).tax;
      const t = extraWithTax(l.amount_minor, rule);
      const group: Array<{ kind: string; status: string; amount_minor: number; tax_included: boolean }> = [{ kind: 'late_fee', status: 'approved', amount_minor: l.amount_minor, tax_included: false }];
      if (t.tax > 0) {
        await trx.insertInto('workspace_booking_lines').values({
          workspace_booking_id: w.id, host_tenant_id: w.host_tenant_id, guest_tenant_id: w.guest_tenant_id, kind: 'tax', status: 'approved', charge_group: 'extra',
          description: `${rule.label ?? 'Tax'} — late fee`, quantity: 1, unit_price_minor: t.tax, amount_minor: t.tax, tax_included: rule.prices_include_tax, created_by: actor.userId,
        }).execute();
        group.push({ kind: 'tax', status: 'approved', amount_minor: t.tax, tax_included: rule.prices_include_tax });
      }
      await postExtraCharge(trx, w, l.id, group, actor.userId);
      await markCorrected(trx, w);
      await notifyGuest(trx, w, 'workspace.late_fee_approved', `اعتمد الصالون رسوم تأخير على ${w.number}`, `The salon approved a late fee on ${w.number}`);
    }
    await audit(trx, actor, input.approve ? 'hosting.late_fee_approved' : 'hosting.late_fee_rejected', { tenantId: access.tenantId, targetType: 'workspace_booking', targetId: w.id, data: { line_id: l.id, amount_minor: l.amount_minor } });
    return hostView(trx, await lockBooking(trx, w.id));
  });
}

/** Guest: requests more product / equipment from the listing's add-ons during the booking. */
export async function requestMaterial(access: TenantAccess, actor: AuditActor, id: string, input: { addon_id: string; quantity: number; note?: string }) {
  return hostingTx('expert requests salon materials during a space booking', async (trx) => {
    const { w } = await lockFor(trx, access, id, 'guest');
    if (!['confirmed', 'checked_in', 'in_use'].includes(w.status)) throw Errors.conflict('invalid_transition', `Space booking is ${w.status}`);
    const a = await trx.selectFrom('workspace_listing_addons').select(['id', 'max_quantity']).where('id', '=', input.addon_id).where('listing_id', '=', w.listing_id).where('tenant_id', '=', w.host_tenant_id).where('is_active', '=', true).executeTakeFirst();
    if (!a) throw Errors.invalid('invalid_addon', 'Unknown add-on');
    if (input.quantity > a.max_quantity) throw Errors.invalid('addon_quantity', 'Quantity too high', { max: a.max_quantity });
    const r = await trx.insertInto('workspace_material_requests').values({
      workspace_booking_id: w.id, host_tenant_id: w.host_tenant_id, guest_tenant_id: w.guest_tenant_id, addon_id: a.id, quantity: input.quantity, note: input.note ?? null, requested_by: actor.userId,
    }).returning(['id', 'status']).executeTakeFirstOrThrow();
    await notifyHost(trx, w, 'workspace.material_requested', `طلب مواد/معدات على ${w.number}`, `Material/equipment request on ${w.number}`);
    await audit(trx, actor, 'workspace.material_requested', { tenantId: access.tenantId, targetType: 'workspace_booking', targetId: w.id, data: { addon_id: a.id, quantity: input.quantity } });
    return r;
  });
}

/** Host decides a material request: approved → add-on line (+ a stock sale for products) charged as dues. */
export async function decideMaterial(access: TenantAccess, actor: AuditActor, id: string, requestId: string, input: { approve: boolean; note?: string }, now = new Date()) {
  return hostingTx('host decides a material request', async (trx) => {
    const { w } = await lockFor(trx, access, id, 'host');
    const r = await trx.selectFrom('workspace_material_requests').selectAll().where('id', '=', requestId).where('workspace_booking_id', '=', w.id).forUpdate().executeTakeFirst();
    if (!r) throw Errors.notFound('material_request');
    if (r.status !== 'requested') throw Errors.conflict('already_decided');
    if (!input.approve) {
      await trx.updateTable('workspace_material_requests').set({ status: 'rejected', decided_by: actor.userId, decided_at: now, decision_note: input.note ?? null }).where('id', '=', r.id).execute();
      await audit(trx, actor, 'hosting.material_rejected', { tenantId: access.tenantId, targetType: 'workspace_booking', targetId: w.id, data: { request_id: r.id } });
      return hostView(trx, w);
    }
    if (!['confirmed', 'checked_in', 'in_use'].includes(w.status)) throw Errors.conflict('invalid_transition', `Space booking is ${w.status}`);
    const a = await trx.selectFrom('workspace_listing_addons as a').leftJoin('product_variants as v', 'v.id', 'a.product_variant_id').leftJoin('products as p', 'p.id', 'v.product_id')
      .select(['a.id', 'a.kind', 'a.product_variant_id', 'a.resource_id', 'a.name_ar', 'a.name_en', 'a.rental_price_minor', 'a.rental_unit', 'v.price_minor', 'p.name_ar as p_ar', 'p.name_en as p_en'])
      .where('a.id', '=', r.addon_id).executeTakeFirstOrThrow();
    const snap = w.terms_snapshot as Snapshot;
    const rule = snap.tax;
    let unit: number;
    if (a.kind === 'product') unit = a.price_minor!;
    else {
      // Shared device: reserved from now (or the start) to the end of the booking; busy elsewhere → refused.
      const from = Math.max(now.getTime(), w.starts_at.getTime());
      if (from >= w.ends_at.getTime()) throw Errors.conflict('booking_ended');
      try {
        await sql`savepoint ws_equipment`.execute(trx);
        await trx.insertInto('booking_allocations').values({ tenant_id: w.host_tenant_id, workspace_booking_id: w.id, resource_id: a.resource_id, during: range(from, w.ends_at.getTime()), state: 'confirmed' }).execute();
        await sql`release savepoint ws_equipment`.execute(trx);
      } catch (e) {
        await sql`rollback to savepoint ws_equipment`.execute(trx);
        if (isPgCode(e, '23P01')) throw Errors.conflict('equipment_unavailable', 'This equipment is in use at that time');
        throw e;
      }
      unit = a.rental_unit === 'hour' ? Math.round((a.rental_price_minor! * (w.ends_at.getTime() - from)) / 3_600_000) : a.rental_price_minor!;
    }
    const amount = unit * r.quantity;
    const discount = Math.round((amount * snap.addons_discount_bp) / 10000);
    const t = extraWithTax(amount - discount, rule);
    const base = { workspace_booking_id: w.id, host_tenant_id: w.host_tenant_id, guest_tenant_id: w.guest_tenant_id, status: 'approved', charge_group: 'extra', material_request_id: r.id, created_by: actor.userId, decided_by: actor.userId, decided_at: now };
    const line = await trx.insertInto('workspace_booking_lines').values({
      ...base, kind: a.kind, description: a.kind === 'product' ? (a.p_ar ?? a.p_en ?? 'product') : (a.name_ar ?? a.name_en ?? 'equipment'),
      addon_id: a.id, product_variant_id: a.product_variant_id, resource_id: a.resource_id, quantity: r.quantity, unit_price_minor: unit, amount_minor: amount,
    }).returningAll().executeTakeFirstOrThrow();
    const group: Array<{ kind: string; status: string; amount_minor: number; tax_included: boolean }> = [{ kind: a.kind, status: 'approved', amount_minor: amount, tax_included: false }];
    if (discount > 0) {
      await trx.insertInto('workspace_booking_lines').values({ ...base, kind: 'discount', description: `Add-ons discount ${snap.addons_discount_bp / 100}%`, quantity: 1, unit_price_minor: -discount, amount_minor: -discount }).execute();
      group.push({ kind: 'discount', status: 'approved', amount_minor: -discount, tax_included: false });
    }
    if (t.tax > 0) {
      await trx.insertInto('workspace_booking_lines').values({ ...base, kind: 'tax', description: rule.label ?? 'Tax', quantity: 1, unit_price_minor: t.tax, amount_minor: t.tax, tax_included: rule.prices_include_tax }).execute();
      group.push({ kind: 'tax', status: 'approved', amount_minor: t.tax, tax_included: rule.prices_include_tax });
    }
    if (a.kind === 'product') {
      const sold = await deliverProductStrict(trx, w, line, actor.userId);
      if (!sold) throw Errors.conflict('addon_out_of_stock', 'Not enough stock');
    }
    await postExtraCharge(trx, w, line.id, group, actor.userId);
    await trx.updateTable('workspace_material_requests').set({ status: 'approved', decided_by: actor.userId, decided_at: now, decision_note: input.note ?? null }).where('id', '=', r.id).execute();
    await markCorrected(trx, w);
    await notifyGuest(trx, w, 'workspace.material_approved', `وافق الصالون على طلب المواد في ${w.number}`, `The salon approved your material request on ${w.number}`);
    await audit(trx, actor, 'hosting.material_approved', { tenantId: access.tenantId, targetType: 'workspace_booking', targetId: w.id, data: { request_id: r.id, amount_minor: amount } });
    return hostView(trx, await lockBooking(trx, w.id));
  });
}

async function deliverProductStrict(trx: Tx, w: NonNullable<WsRow>, l: LineRow, userId: string | null) {
  const sold = await sellAddonStock(trx, w.host_tenant_id, { id: l.id, product_variant_id: l.product_variant_id!, quantity: Number(l.quantity), branch_id: w.branch_id }, userId);
  if (!sold) return null;
  await trx.updateTable('workspace_booking_lines').set({ inventory_item_id: sold.itemId, unit_cost_minor: sold.unitCostMinor, stock_moved_at: new Date() }).where('id', '=', l.id).execute();
  return sold;
}

// ── Settlement ──────────────────────────────────────────────────────────────
export async function approveSettlement(access: TenantAccess, actor: AuditActor, id: string) {
  return hostingTx('host approves a space settlement', async (trx) => {
    const { w } = await lockFor(trx, access, id, 'host');
    if (!['completed', 'cancelled', 'no_show', 'expired'].includes(w.status)) throw Errors.conflict('booking_open', 'Settle after the booking is completed or closed');
    if (w.settlement_status === 'approved' || w.settlement_status === 'settled') throw Errors.conflict('already_approved');
    const pending = await trx.selectFrom('workspace_booking_lines').select('id').where('workspace_booking_id', '=', w.id).where('status', '=', 'proposed').executeTakeFirst();
    if (pending) throw Errors.conflict('late_fee_pending', 'Approve or reject the proposed late fee first');
    const s = await statement(trx, w);
    const prev = await trx.selectFrom('workspace_settlements').select(sql<number>`coalesce(max(version), 0)::int`.as('v')).where('workspace_booking_id', '=', w.id).executeTakeFirstOrThrow();
    const status = s.due_from_guest_minor === 0 && s.credit_to_guest_minor === 0 ? 'settled' : 'approved';
    const row = await trx.insertInto('workspace_settlements').values({
      workspace_booking_id: w.id, host_tenant_id: w.host_tenant_id, guest_tenant_id: w.guest_tenant_id, version: prev.v + 1, statement: JSON.stringify({ ...s, settlement_status: status }), approved_by: actor.userId,
    }).returning(['id', 'version', 'approved_at']).executeTakeFirstOrThrow();
    await trx.updateTable('workspace_bookings').set({ settlement_status: status }).where('id', '=', w.id).execute();
    await audit(trx, actor, 'hosting.settlement_approved', { tenantId: access.tenantId, targetType: 'workspace_booking', targetId: w.id, data: { version: row.version, total_minor: s.total_charges_minor } });
    return { ...row, settlement_status: status, statement: s };
  });
}

/** A correction after approval is a new line (never an edit); negative corrections are refunded. */
export async function addCorrection(access: TenantAccess, actor: AuditActor, id: string, input: { amount_minor: number; description: string }) {
  return hostingTx('host records a space settlement correction', async (trx) => {
    const { w } = await lockFor(trx, access, id, 'host');
    if (!['completed', 'cancelled', 'no_show', 'checked_in', 'in_use', 'confirmed'].includes(w.status)) throw Errors.conflict('invalid_transition');
    const line = await trx.insertInto('workspace_booking_lines').values({
      workspace_booking_id: w.id, host_tenant_id: w.host_tenant_id, guest_tenant_id: w.guest_tenant_id, kind: 'correction', status: 'approved', charge_group: 'extra',
      description: input.description, quantity: 1, unit_price_minor: input.amount_minor, amount_minor: input.amount_minor, created_by: actor.userId, decided_by: actor.userId, decided_at: new Date(),
    }).returningAll().executeTakeFirstOrThrow();
    if (input.amount_minor > 0) {
      await postExtraCharge(trx, w, line.id, [line], actor.userId);
    } else {
      const lastPay = (await bookingLines(trx, w.id)).find((l) => l.payment_id)?.payment_id ?? null;
      await trx.updateTable('workspace_booking_lines').set({ payment_id: lastPay }).where('id', '=', line.id).execute();
      const refunded = await refundWorkspaceDue(trx, w.host_tenant_id, w.id, -input.amount_minor, `correction:${line.id}`);
      if (refunded < -input.amount_minor) throw Errors.invalid('refund_exceeds_payment', 'The correction exceeds what was paid');
    }
    await markCorrected(trx, w);
    await audit(trx, actor, 'hosting.settlement_corrected', { tenantId: access.tenantId, targetType: 'workspace_booking', targetId: w.id, data: { line_id: line.id, amount_minor: input.amount_minor } });
    return hostView(trx, await lockBooking(trx, w.id));
  });
}

// ── Review (D9) ─────────────────────────────────────────────────────────────
export async function reviewSpace(access: TenantAccess, actor: AuditActor, id: string, input: { rating: number; body?: string }) {
  return hostingTx('expert rates a space after a completed booking', async (trx) => {
    const { w } = await lockFor(trx, access, id, 'guest');
    if (w.status !== 'completed') throw Errors.conflict('not_completed', 'You can rate a space after a completed booking');
    const exists = await trx.selectFrom('workspace_reviews').select('id').where('workspace_booking_id', '=', w.id).executeTakeFirst();
    if (exists) throw Errors.conflict('already_reviewed');
    const r = await trx.insertInto('workspace_reviews').values({
      workspace_booking_id: w.id, host_tenant_id: w.host_tenant_id, guest_tenant_id: w.guest_tenant_id, listing_id: w.listing_id, rating: input.rating, body: input.body ?? null, created_by: actor.userId,
    }).returningAll().executeTakeFirstOrThrow();
    await audit(trx, actor, 'workspace.reviewed', { tenantId: access.tenantId, targetType: 'workspace_booking', targetId: w.id, data: { rating: input.rating } });
    return r;
  });
}

// ── Views ───────────────────────────────────────────────────────────────────
const COMMON = ['id', 'number', 'listing_id', 'status', 'booking_mode', 'payment_status', 'settlement_status', 'starts_at', 'ends_at', 'timezone', 'currency',
  'rent_minor', 'addons_minor', 'discount_minor', 'tax_minor', 'total_minor', 'paid_minor', 'refunded_minor', 'hold_expires_at', 'approval_deadline',
  'checked_in_at', 'checked_out_at', 'confirmed_at', 'completed_at', 'cancelled_at', 'cancel_source', 'cancel_reason', 'guest_note', 'host_note', 'version', 'created_at'] as const;

function pickCommon(w: NonNullable<WsRow>) {
  return Object.fromEntries(COMMON.map((k) => [k, w[k]])) as Pick<NonNullable<WsRow>, (typeof COMMON)[number]>;
}

/** Host view: the space booking only — the expert's business name, never her clients (D14). */
export async function hostView(trx: Tx, w: NonNullable<WsRow>) {
  const snap = w.terms_snapshot as Snapshot;
  const [requests, events, settlements] = await Promise.all([
    trx.selectFrom('workspace_material_requests').select(['id', 'addon_id', 'quantity', 'note', 'status', 'decision_note', 'created_at']).where('workspace_booking_id', '=', w.id).orderBy('created_at').execute(),
    trx.selectFrom('workspace_booking_events').select(['from_status', 'to_status', 'actor_kind', 'reason', 'created_at']).where('workspace_booking_id', '=', w.id).orderBy('created_at').execute(),
    trx.selectFrom('workspace_settlements').select(['id', 'version', 'approved_at', 'statement']).where('workspace_booking_id', '=', w.id).orderBy('version').execute(),
  ]);
  return {
    ...pickCommon(w), as: 'host', check_in_code: w.check_in_code,
    guest: { name: (w.guest_snapshot as { name?: string }).name ?? null, provider_name: (w.guest_snapshot as { provider_name?: string }).provider_name ?? null },
    space: { code: snap.code, title_ar: snap.title_ar, title_en: snap.title_en },
    terms: snap, statement: await statement(trx, w), material_requests: requests, events, settlements,
  };
}

/** Guest view: full terms, access instructions only once confirmed, QR token, her linked appointments. */
export async function guestView(trx: Tx, w: NonNullable<WsRow>) {
  const snap = w.terms_snapshot as Snapshot;
  const confirmed = ['confirmed', 'checked_in', 'in_use', 'completed'].includes(w.status);
  const linked = await trx.selectFrom('bookings').select(['id', 'number', 'status', 'starts_at', 'ends_at']).where('tenant_id', '=', w.guest_tenant_id).where('workspace_booking_id', '=', w.id).orderBy('starts_at').execute();
  const requests = await trx.selectFrom('workspace_material_requests').select(['id', 'addon_id', 'quantity', 'note', 'status', 'decision_note', 'created_at']).where('workspace_booking_id', '=', w.id).orderBy('created_at').execute();
  const review = await trx.selectFrom('workspace_reviews').select(['rating', 'body', 'created_at']).where('workspace_booking_id', '=', w.id).executeTakeFirst();
  const invoices = await trx.selectFrom('invoices').select(['id', 'number', 'total_minor', 'currency', 'issued_at']).where('tenant_id', '=', w.host_tenant_id).where('workspace_booking_id', '=', w.id).orderBy('issued_at').execute();
  const { access_instructions_ar, access_instructions_en, ...terms } = snap;
  return {
    ...pickCommon(w), as: 'guest',
    /** Her own provider profile that holds the space (appointments inside it must use it). */
    guest_staff_id: w.guest_staff_id,
    /** Space setup/cleanup buffers from the frozen terms: the host's preparation, outside her window. */
    buffers: { setup_min: snap.setup_buffer_min, cleanup_min: snap.cleanup_buffer_min },
    host: w.host_snapshot,
    location_confirmed: confirmed,
    qr_token: confirmed ? w.qr_token : null,
    terms, access_instructions: confirmed ? { ar: access_instructions_ar, en: access_instructions_en } : null,
    statement: await statement(trx, w), linked_appointments: linked, material_requests: requests, review: review ?? null, invoices,
    can: {
      pay: w.status === 'held', cancel: canTransition('cancel', w.status, 'guest') && !(w.status === 'confirmed' && new Date() >= w.starts_at),
      check_in: w.status === 'confirmed', check_out: ['checked_in', 'in_use'].includes(w.status), review: w.status === 'completed' && !review,
      request_material: ['confirmed', 'checked_in', 'in_use'].includes(w.status),
      add_appointment: ['confirmed', 'checked_in', 'in_use'].includes(w.status) && new Date() < w.ends_at,
    },
  };
}

export async function getForHost(access: TenantAccess, id: string) {
  return hostingTx('host reads a space booking', async (trx) => {
    const { w } = await lockFor(trx, access, id, 'host');
    return hostView(trx, await settleTimeouts(trx, w));
  });
}

export async function getForGuest(access: TenantAccess, id: string) {
  return hostingTx('expert reads her space booking', async (trx) => {
    const { w } = await lockFor(trx, access, id, 'guest');
    return guestView(trx, await settleTimeouts(trx, w));
  });
}

/** One invoice of a guest's space booking (the invoice lives in the host's books). */
export async function guestInvoice(access: TenantAccess, id: string, invoiceId: string) {
  return hostingTx('expert reads an invoice issued to her business', async (trx) => {
    const { w } = await lockFor(trx, access, id, 'guest');
    const inv = await trx.selectFrom('invoices').selectAll().where('id', '=', invoiceId).where('tenant_id', '=', w.host_tenant_id).where('workspace_booking_id', '=', w.id).executeTakeFirst();
    if (!inv) throw Errors.notFound('invoice');
    const items = await trx.selectFrom('invoice_items').selectAll().where('invoice_id', '=', inv.id).where('tenant_id', '=', w.host_tenant_id).execute();
    return { ...inv, items, tenant: { slug: (w.host_snapshot as { slug?: string }).slug ?? '', timezone: w.timezone } };
  });
}

const LIST_FIELDS = ['id', 'number', 'listing_id', 'status', 'payment_status', 'settlement_status', 'starts_at', 'ends_at', 'timezone', 'total_minor', 'paid_minor', 'refunded_minor', 'currency', 'hold_expires_at', 'booking_mode'] as const;

function displayStatus(r: { status: string; hold_expires_at: Date | null }, now: Date) {
  return ['pending_approval', 'held', 'pending_payment'].includes(r.status) && r.hold_expires_at && r.hold_expires_at <= now ? 'expired' : r.status;
}

export async function listForHost(trx: Tx, hostTenantId: string, status?: string[]) {
  const now = new Date();
  const rows = await trx.selectFrom('workspace_bookings').select([...LIST_FIELDS, 'guest_snapshot', 'terms_snapshot'])
    .where('host_tenant_id', '=', hostTenantId).$if(!!status?.length, (q) => q.where('status', 'in', status!)).orderBy('starts_at', 'desc').limit(300).execute();
  return rows.map(({ guest_snapshot, terms_snapshot, ...r }) => ({ ...r, status: displayStatus(r, now), guest_name: (guest_snapshot as { name?: string }).name ?? null, space_code: (terms_snapshot as Snapshot).code }));
}

export async function listForGuest(trx: Tx, guestTenantId: string) {
  const now = new Date();
  const rows = await trx.selectFrom('workspace_bookings').select([...LIST_FIELDS, 'host_snapshot', 'terms_snapshot'])
    .where('guest_tenant_id', '=', guestTenantId).orderBy('starts_at', 'desc').limit(300).execute();
  return rows.map(({ host_snapshot, terms_snapshot, ...r }) => ({ ...r, status: displayStatus(r, now), host: host_snapshot, space_code: (terms_snapshot as Snapshot).code }));
}

/** Location of a client appointment placed in a space booking, as the client may see it (guest tenant scope). */
export async function appointmentLocation(trx: Tx, guestTenantId: string, workspaceBookingId: string) {
  const w = await trx.selectFrom('workspace_bookings').select(['status', 'host_snapshot', 'starts_at', 'ends_at', 'guest_tenant_id']).where('id', '=', workspaceBookingId).executeTakeFirst();
  if (!w || w.guest_tenant_id !== guestTenantId) return null;
  const confirmed = ['confirmed', 'checked_in', 'in_use', 'completed'].includes(w.status);
  const h = w.host_snapshot as { name?: string; branch_name?: string; address?: string | null; city?: string | null };
  // An unconfirmed space is never presented as the confirmed location.
  return confirmed ? { confirmed: true, host_name: h.name ?? null, branch_name: h.branch_name ?? null, address: h.address ?? null, city: h.city ?? null } : { confirmed: false };
}

