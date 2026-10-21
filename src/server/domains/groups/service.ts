import { sql } from 'kysely';
import type { z } from 'zod';
import { withTenant, type Tx } from '../../db/client';
import { AppError, Errors, isPgCode } from '../../http/errors';
import { audit, type AuditActor } from '../../infra/audit';
import { idempotent, requestHash } from '../../infra/idempotency';
import { nextReadableNumber } from '../../infra/counters';
import type { SessionUser } from '../../auth/service';
import { requireFeature, type TenantAccess } from '../../tenancy/access';
import { ensureTenantCustomerForUser } from '../customers/relationship';
import { computeTotals } from '../booking/pricing';
import { policySnapshot } from '../booking/service';
import type { groupSessionInput } from '@/shared/schemas/waitlist';

/**
 * Group sessions with shared capacity. The instructor's (and resource's) time
 * is reserved with the same exclusion constraints as individual bookings, so a
 * session can never overlap another appointment. Seats are taken under a row
 * lock on the session with a CHECK (seats_taken <= capacity) as the final guard.
 */
export async function createSession(access: TenantAccess, actor: AuditActor, input: z.infer<typeof groupSessionInput>) {
  requireFeature(access, 'feature.group_sessions');
  return withTenant(access.tenantId, async (trx) => {
    const svc = await trx.selectFrom('services').selectAll().where('id', '=', input.service_id).executeTakeFirst();
    if (!svc || svc.archived_at || !svc.is_active) throw Errors.invalid('service_unavailable');
    if (svc.booking_mode !== 'group') throw Errors.invalid('not_group_service', 'This service is not configured for group sessions');
    const qualified = await trx.selectFrom('service_staff').select('staff_id').where('service_id', '=', svc.id).where('staff_id', '=', input.staff_id).executeTakeFirst();
    if (!qualified) throw Errors.invalid('staff_not_qualified');
    const start = new Date(input.starts_at);
    if (start <= new Date()) throw Errors.invalid('in_past');
    const end = new Date(start.getTime() + svc.duration_min * 60_000);
    const occStart = new Date(start.getTime() - svc.buffer_before_min * 60_000);
    const occEnd = new Date(end.getTime() + svc.buffer_after_min * 60_000);
    const s = await trx.insertInto('group_sessions').values({
      tenant_id: access.tenantId, branch_id: input.branch_id, service_id: svc.id, staff_id: input.staff_id, resource_id: input.resource_id ?? null,
      starts_at: start, ends_at: end, capacity: input.capacity, price_minor: input.price_minor ?? svc.price_minor, title_ar: input.title_ar ?? svc.name_ar, title_en: input.title_en ?? svc.name_en,
    }).returningAll().executeTakeFirstOrThrow();
    const during = `[${occStart.toISOString()},${occEnd.toISOString()})`;
    try {
      await trx.insertInto('booking_allocations').values({ tenant_id: access.tenantId, group_session_id: s.id, staff_id: input.staff_id, during, state: 'confirmed' }).execute();
      if (input.resource_id) await trx.insertInto('booking_allocations').values({ tenant_id: access.tenantId, group_session_id: s.id, resource_id: input.resource_id, during, state: 'confirmed' }).execute();
    } catch (e) {
      if (isPgCode(e, '23P01')) throw new AppError(409, 'slot_unavailable', 'The instructor or room is already booked at that time');
      throw e;
    }
    await audit(trx, actor, 'group_session.created', { tenantId: access.tenantId, targetType: 'group_session', targetId: s.id, data: { capacity: input.capacity } });
    return s;
  });
}

export async function listSessions(tenantId: string, opts: { from: Date; to: Date; publicOnly?: boolean }) {
  return withTenant(tenantId, (trx) => trx.selectFrom('group_sessions as g').innerJoin('staff_profiles as sp', 'sp.id', 'g.staff_id').innerJoin('services as s', 's.id', 'g.service_id')
    .select(['g.id', 'g.title_ar', 'g.title_en', 'g.starts_at', 'g.ends_at', 'g.capacity', 'g.seats_taken', 'g.price_minor', 'g.status', 'g.service_id', 'sp.display_name as staff_name'])
    .where('g.starts_at', '>=', opts.from).where('g.starts_at', '<', opts.to)
    .$if(!!opts.publicOnly, (q) => q.where('g.status', '=', 'scheduled').where('s.is_visible', '=', true).where('sp.is_public', '=', true))
    .orderBy('g.starts_at').execute());
}

/** Books seats in a session for the signed-in customer (no overbooking, idempotent). */
export async function bookSeats(tenantId: string, user: SessionUser, sessionId: string, seats: number, idempotencyKey: string, actor: AuditActor) {
  return withTenant(tenantId, (trx) => idempotent(trx, { scope: `tenant:${tenantId}:user:${user.userId}`, operation: 'group.book', key: idempotencyKey, hash: requestHash({ sessionId, seats }) }, async () => {
    const g = await trx.selectFrom('group_sessions').selectAll().where('id', '=', sessionId).forUpdate().executeTakeFirst();
    if (!g || g.status !== 'scheduled') throw Errors.notFound('group_session');
    if (g.starts_at <= new Date()) throw Errors.invalid('in_past');
    if (g.seats_taken + seats > g.capacity) throw Errors.conflict('session_full', 'Not enough seats left', { seats_left: g.capacity - g.seats_taken });
    const tcId = await ensureTenantCustomerForUser(trx, tenantId, { userId: user.userId, displayName: user.displayName, phone: user.phone, email: user.email });
    const already = await trx.selectFrom('group_session_bookings as gb').innerJoin('bookings as b', 'b.id', 'gb.booking_id')
      .select('gb.id').where('gb.group_session_id', '=', sessionId).where('gb.status', '=', 'active').where('b.tenant_customer_id', '=', tcId).executeTakeFirst();
    if (already) throw Errors.conflict('already_booked', 'You already have seats in this session');
    const policy = await policySnapshot(trx, tenantId);
    const totals = computeTotals(g.price_minor * seats, 0, policy.tax_rate_bp, policy.prices_include_tax);
    const staff = await trx.selectFrom('staff_profiles').select('display_name').where('id', '=', g.staff_id).executeTakeFirstOrThrow();
    const branch = await trx.selectFrom('branches').select('timezone').where('id', '=', g.branch_id).executeTakeFirstOrThrow();
    const number = await nextReadableNumber(trx, tenantId, 'booking');
    const b = await trx.insertInto('bookings').values({
      tenant_id: tenantId, branch_id: g.branch_id, number, tenant_customer_id: tcId, customer_user_id: user.userId, status: 'confirmed', source: 'storefront',
      starts_at: g.starts_at, ends_at: g.ends_at, timezone: branch.timezone, subtotal_minor: totals.subtotal, tax_minor: totals.tax, total_minor: totals.total,
      policy_snapshot: JSON.stringify(policy), payment_terms: JSON.stringify({ allowed: ['on_site'], group_session: true }), created_by: user.userId,
    }).returning(['id', 'number']).executeTakeFirstOrThrow();
    await trx.insertInto('booking_items').values({
      tenant_id: tenantId, booking_id: b.id, sequence: 0, service_id: g.service_id, staff_id: g.staff_id, starts_at: g.starts_at, ends_at: g.ends_at,
      service_name_ar: g.title_ar, service_name_en: g.title_en, staff_name: staff.display_name,
      duration_min: Math.round((g.ends_at.getTime() - g.starts_at.getTime()) / 60_000), unit_price_minor: g.price_minor, line_total_minor: g.price_minor * seats,
    }).execute();
    await trx.insertInto('group_session_bookings').values({ tenant_id: tenantId, group_session_id: sessionId, booking_id: b.id, seats }).execute();
    await trx.updateTable('group_sessions').set({ seats_taken: sql`seats_taken + ${seats}` }).where('id', '=', sessionId).execute();
    await trx.insertInto('booking_events').values({ tenant_id: tenantId, booking_id: b.id, to_status: 'confirmed', kind: 'created', source: 'storefront', actor_user_id: user.userId, data: JSON.stringify({ group_session_id: sessionId, seats }) }).execute();
    await audit(trx, actor, 'group_session.booked', { tenantId, targetType: 'group_session', targetId: sessionId, data: { seats } });
    return { status: 201, body: { booking_id: b.id, number: b.number, seats, seats_left: g.capacity - g.seats_taken - seats } };
  }));
}

/** Booking hook: releasing a group booking frees its seats exactly once. */
export async function releaseSeats(trx: Tx, bookingId: string) {
  const gb = await trx.updateTable('group_session_bookings').set({ status: 'released', released_at: new Date() }).where('booking_id', '=', bookingId).where('status', '=', 'active')
    .returning(['group_session_id', 'seats']).executeTakeFirst();
  if (gb) await trx.updateTable('group_sessions').set({ seats_taken: sql`seats_taken - ${gb.seats}` }).where('id', '=', gb.group_session_id).execute();
}

/** Cancels a session: every seat booking is cancelled through the transition table (refunds per terms). */
export async function cancelSession(access: TenantAccess, actor: AuditActor, sessionId: string, reason: string) {
  const { transition } = await import('../booking/service');
  const bookingIds = await withTenant(access.tenantId, async (trx) => {
    const g = await trx.updateTable('group_sessions').set({ status: 'cancelled', cancelled_reason: reason }).where('id', '=', sessionId).where('status', '=', 'scheduled').returning('id').executeTakeFirst();
    if (!g) throw Errors.notFound('group_session');
    await trx.updateTable('booking_allocations').set({ state: 'released', released_at: new Date() }).where('group_session_id', '=', sessionId).where('state', '<>', 'released').execute();
    await audit(trx, actor, 'group_session.cancelled', { tenantId: access.tenantId, targetType: 'group_session', targetId: sessionId, data: { reason } });
    return (await trx.selectFrom('group_session_bookings').select('booking_id').where('group_session_id', '=', sessionId).where('status', '=', 'active').execute()).map((r) => r.booking_id);
  });
  for (const id of bookingIds) await transition(access.tenantId, id, 'cancel', { kind: 'staff', access, audit: actor }, { reason: `session cancelled: ${reason}` });
  return { cancelled_bookings: bookingIds.length };
}
