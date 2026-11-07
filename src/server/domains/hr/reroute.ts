import { DateTime } from 'luxon';
import { sql } from 'kysely';
import { z } from 'zod';
import { withTenant, type Tx } from '../../db/client';
import { AppError, Errors } from '../../http/errors';
import type { AuditActor } from '../../infra/audit';
import { notifyUsers } from '../../infra/notify';
import type { TenantAccess } from '../../tenancy/access';
import { validateItinerary } from '../booking/engine';
import { loadEngineInput, resolveItems, type ResolvedItem } from '../booking/loader';
import { reschedule, transition, type HoldItem } from '../booking/service';

/**
 * Bookings affected by an approved leave. For each one the system suggests a
 * colleague who offers the same services and is free at the same time
 * (validated with the booking engine, as a reschedule would be); the owner
 * approves it with one click (an atomic reschedule onto the colleague). With
 * no colleague available she moves the appointment to another time or
 * cancels it (the customer is notified through the usual booking messages).
 * Every action is logged in booking_reroutes.
 */

const ACTIVE = ['pending_approval', 'confirmed'] as const;

type Item = { id: string; booking_id: string; sequence: number; service_id: string; variant_id: string | null; addons: unknown; staff_id: string; starts_at: Date; ends_at: Date; line_total_minor: number; service_name_ar: string | null; service_name_en: string | null };

async function loadLeave(trx: Tx, leaveId: string) {
  const lr = await trx.selectFrom('leave_requests').select(['id', 'staff_id', 'status', 'affected_booking_ids', sql<Date>`lower(during)`.as('from_at'), sql<Date>`upper(during)`.as('to_at')])
    .where('id', '=', leaveId).executeTakeFirst();
  if (!lr) throw Errors.notFound('leave');
  return lr;
}

const addonIds = (a: unknown) => (Array.isArray(a) ? a.map((x) => (x as { id: string }).id).filter(Boolean) : []);

/** Requested items with the leave staff's items given to `to` and times shifted by `shiftMs`. */
function plan(items: Item[], leaveStaff: string, to: string | null, shiftMs = 0): HoldItem[] {
  return items.map((i) => ({
    key: i.id, serviceId: i.service_id, variantId: i.variant_id, addonIds: addonIds(i.addons),
    staffId: i.staff_id === leaveStaff && to ? to : i.staff_id, start: new Date(i.starts_at.getTime() + shiftMs).toISOString(),
  }));
}

/** Colleagues free for the leave staff's items of this booking, best first (same price first). */
async function candidatesFor(trx: Tx, tenantId: string, booking: { id: string; branch_id: string; timezone: string }, items: Item[], leaveStaff: string) {
  let resolved: ResolvedItem[];
  try {
    resolved = await resolveItems(trx, tenantId, booking.branch_id, items.map((i) => ({ key: i.id, serviceId: i.service_id, variantId: i.variant_id, addonIds: addonIds(i.addons) })), 'internal');
  } catch {
    return [];
  }
  const dates = items.map((i) => DateTime.fromJSDate(i.starts_at, { zone: booking.timezone }).toISODate()!).sort();
  const engine = await loadEngineInput(trx, tenantId, booking.branch_id, resolved, dates[0]!, dates[dates.length - 1]!);
  // The booking's own allocations must not block its replacement.
  const own = await trx.selectFrom('booking_allocations').select(['staff_id', sql<Date>`lower(during)`.as('s'), sql<Date>`upper(during)`.as('e')])
    .where('booking_id', '=', booking.id).where('state', '<>', 'released').execute();
  for (const a of own) {
    const s = a.staff_id ? engine.staff[a.staff_id] : null;
    if (s) s.busy = s.busy.filter((b) => !(b.start === a.s.getTime() && b.end === a.e.getTime()));
  }
  const theirs = items.filter((i) => i.staff_id === leaveStaff);
  const pool = resolved.filter((r) => theirs.some((i) => i.id === r.key));
  const qualified = [...new Set(pool.flatMap((r) => r.spec.qualifiedStaff))].filter((s) => s !== leaveStaff && pool.every((r) => r.spec.qualifiedStaff.includes(s)));
  const out: Array<{ staff_id: string; staff_name: string; same_price: boolean }> = [];
  for (const c of qualified) {
    const req = plan(items, leaveStaff, c).map((h) => ({ key: h.key, staffId: h.staffId, start: Date.parse(h.start) }));
    const check = validateItinerary(engine, resolved.map((r) => r.spec), req);
    if (!check.ok) continue;
    const samePrice = pool.every((r) => r.staffTerms[c]!.priceMinor === theirs.find((i) => i.id === r.key)!.line_total_minor);
    out.push({ staff_id: c, staff_name: pool[0]!.staffTerms[c]!.name, same_price: samePrice });
  }
  return out.sort((a, b) => Number(b.same_price) - Number(a.same_price));
}

/** The affected bookings still on the leave staff, each with suggested colleagues, and the reroute log. */
export async function rerouteSuggestions(access: TenantAccess, leaveId: string) {
  return withTenant(access.tenantId, async (trx) => {
    const lr = await loadLeave(trx, leaveId);
    if (lr.status !== 'approved') throw Errors.conflict('leave_not_approved', 'This leave is not approved');
    const bookingIds = await trx.selectFrom('booking_items as i').innerJoin('bookings as b', 'b.id', 'i.booking_id').select('b.id').distinct()
      .where('i.staff_id', '=', lr.staff_id).where('i.superseded_at', 'is', null).where('b.status', 'in', [...ACTIVE])
      .where('i.starts_at', '<', lr.to_at).where('i.ends_at', '>', lr.from_at).execute();
    const out = [];
    for (const { id } of bookingIds) {
      const b = await trx.selectFrom('bookings as b').innerJoin('tenant_customers as c', 'c.id', 'b.tenant_customer_id')
        .select(['b.id', 'b.number', 'b.status', 'b.branch_id', 'b.timezone', 'b.starts_at', 'b.ends_at', 'b.total_minor', 'c.display_name as customer_name'])
        .where('b.id', '=', id).executeTakeFirstOrThrow();
      const items = await trx.selectFrom('booking_items').select(['id', 'booking_id', 'sequence', 'service_id', 'variant_id', 'addons', 'staff_id', 'starts_at', 'ends_at', 'line_total_minor', 'service_name_ar', 'service_name_en'])
        .where('booking_id', '=', id).where('superseded_at', 'is', null).orderBy('sequence').execute();
      const candidates = await candidatesFor(trx, access.tenantId, b, items, lr.staff_id);
      out.push({
        booking_id: b.id, number: b.number, status: b.status, starts_at: b.starts_at, ends_at: b.ends_at, timezone: b.timezone, customer_name: b.customer_name, total_minor: b.total_minor,
        services: items.filter((i) => i.staff_id === lr.staff_id).map((i) => ({ name_ar: i.service_name_ar, name_en: i.service_name_en, starts_at: i.starts_at })),
        candidates, suggested_staff_id: candidates[0]?.staff_id ?? null,
      });
    }
    const log = await trx.selectFrom('booking_reroutes as r').innerJoin('bookings as b', 'b.id', 'r.booking_id').leftJoin('staff_profiles as s', 's.id', 'r.to_staff_id')
      .select(['r.id', 'r.booking_id', 'b.number', 'r.action', 'r.from_staff_id', 'r.to_staff_id', 's.display_name as to_staff_name', 'r.from_starts_at', 'r.to_starts_at', 'r.note', 'r.created_at'])
      .where('r.leave_request_id', '=', leaveId).orderBy('r.created_at', 'desc').execute();
    return { leave_id: leaveId, staff_id: lr.staff_id, bookings: out, log };
  });
}

export const rerouteInput = z.discriminatedUnion('action', [
  z.object({ action: z.literal('reassign'), booking_id: z.string().uuid(), to_staff_id: z.string().uuid(), accept_total_minor: z.number().int().min(0).optional() }).strict(),
  z.object({ action: z.literal('reschedule'), booking_id: z.string().uuid(), start: z.string().datetime({ offset: true }), staff_id: z.string().uuid().optional(), accept_total_minor: z.number().int().min(0).optional() }).strict(),
  z.object({ action: z.literal('cancel'), booking_id: z.string().uuid(), reason: z.string().trim().min(3).max(500) }).strict(),
]);

export async function applyReroute(access: TenantAccess, actor: AuditActor, leaveId: string, input: z.infer<typeof rerouteInput>) {
  const ctx = await withTenant(access.tenantId, async (trx) => {
    const lr = await loadLeave(trx, leaveId);
    if (lr.status !== 'approved') throw Errors.conflict('leave_not_approved', 'This leave is not approved');
    const b = await trx.selectFrom('bookings').select(['id', 'status', 'starts_at', 'customer_user_id', 'number']).where('id', '=', input.booking_id).executeTakeFirst();
    if (!b) throw Errors.notFound('booking');
    const items = await trx.selectFrom('booking_items').select(['id', 'booking_id', 'sequence', 'service_id', 'variant_id', 'addons', 'staff_id', 'starts_at', 'ends_at', 'line_total_minor', 'service_name_ar', 'service_name_en'])
      .where('booking_id', '=', b.id).where('superseded_at', 'is', null).orderBy('sequence').execute();
    const onLeave = items.some((i) => i.staff_id === lr.staff_id && i.starts_at < lr.to_at && i.ends_at > lr.from_at);
    if (!onLeave && !lr.affected_booking_ids.includes(b.id)) throw Errors.invalid('booking_not_affected', 'This booking is not affected by the leave');
    return { lr, b, items };
  });
  const staffActor = { kind: 'staff' as const, access, audit: actor };
  let to: { staff: string | null; starts: Date | null } = { staff: null, starts: null };
  if (input.action === 'cancel') {
    await transition(access.tenantId, input.booking_id, 'cancel', staffActor, { reason: input.reason });
  } else {
    const shift = input.action === 'reschedule' ? Date.parse(input.start) - ctx.b.starts_at.getTime() : 0;
    const target = input.action === 'reassign' ? input.to_staff_id : input.staff_id ?? null;
    if (input.action === 'reassign' && target === ctx.lr.staff_id) throw Errors.invalid('staff_on_leave', 'Choose another colleague');
    try {
      await reschedule(access.tenantId, input.booking_id, staffActor, { items: plan(ctx.items, ctx.lr.staff_id, target, shift), acceptTotalMinor: input.accept_total_minor });
    } catch (e) {
      if (e instanceof AppError && e.code === 'slot_unavailable') throw new AppError(409, 'reroute_slot_unavailable', 'That colleague or time is no longer free', e.details);
      throw e;
    }
    to = { staff: target, starts: new Date(ctx.b.starts_at.getTime() + shift) };
  }
  return withTenant(access.tenantId, async (trx) => {
    const fromStaff = ctx.lr.staff_id;
    const row = await trx.insertInto('booking_reroutes').values({
      tenant_id: access.tenantId, leave_request_id: leaveId, booking_id: input.booking_id,
      action: input.action === 'reassign' ? 'reassigned' : input.action === 'reschedule' ? 'rescheduled' : 'cancelled',
      from_staff_id: fromStaff, to_staff_id: to.staff, from_starts_at: ctx.b.starts_at, to_starts_at: to.starts,
      note: input.action === 'cancel' ? input.reason : null, actor_user_id: actor.userId,
    }).returningAll().executeTakeFirstOrThrow();
    if (input.action === 'cancel' && ctx.b.customer_user_id) {
      // In-app notice for the customer (messages go through the booking outbox as usual).
      await notifyUsers(trx, access.tenantId, [ctx.b.customer_user_id], {
        kind: 'booking.cancelled_staff_leave', title_ar: `تم إلغاء موعدك (${ctx.b.number}) لعدم توفر الخبيرة`, title_en: `Your appointment (${ctx.b.number}) was cancelled: the specialist is unavailable`,
        target_path: `/account/bookings/${input.booking_id}`,
      });
    }
    return row;
  });
}
