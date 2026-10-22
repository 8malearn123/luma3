import type { z } from 'zod';
import { sql, withTenant } from '../../db/client';
import { Errors } from '../../http/errors';
import { audit, type AuditActor } from '../../infra/audit';
import { notifyCapability, notifyStaff } from '../../infra/notify';
import { hasCapability, type TenantAccess } from '../../tenancy/access';
import { futureBookingsFor } from '../team/service';
import type { leaveDecision, leaveInput, overrideInput, timeBlockInput, weeklyHoursInput } from '@/shared/schemas/team';

/** A specialist may only see/act on her own staff profile unless she can manage schedules. */
function assertStaffScope(access: TenantAccess, staffId: string) {
  if (hasCapability(access, 'schedule.manage')) return;
  if (access.staffProfileId && access.staffProfileId === staffId && hasCapability(access, 'schedule.view_own')) return;
  throw Errors.notFound('staff');
}

export async function getSchedule(access: TenantAccess, staffId: string, range?: { from: string; to: string }) {
  assertStaffScope(access, staffId);
  return withTenant(access.tenantId, async (trx) => {
    const staff = await trx.selectFrom('staff_profiles').select(['id', 'display_name', 'is_active']).where('id', '=', staffId).executeTakeFirst();
    if (!staff) throw Errors.notFound('staff');
    const [hours, breaks, overrides, blocks, leave] = await Promise.all([
      trx.selectFrom('working_hours').selectAll().where('staff_id', '=', staffId).orderBy('weekday').orderBy('start_time').execute(),
      trx.selectFrom('staff_breaks').selectAll().where('staff_id', '=', staffId).execute(),
      trx.selectFrom('shift_overrides').selectAll().where('staff_id', '=', staffId)
        .$if(!!range, (q) => q.where('on_date', '>=', range!.from).where('on_date', '<=', range!.to)).orderBy('on_date').execute(),
      trx.selectFrom('time_blocks').selectAll().where('staff_id', '=', staffId).execute(),
      trx.selectFrom('leave_requests').selectAll().where('staff_id', '=', staffId).orderBy('created_at', 'desc').limit(50).execute(),
    ]);
    return { staff, hours, breaks, overrides, blocks, leave };
  });
}

/** Replaces the weekly pattern (ranges + recurring breaks) for one staff member at one branch. */
export async function setWeeklyHours(access: TenantAccess, actor: AuditActor, staffId: string, input: z.infer<typeof weeklyHoursInput>) {
  for (const r of [...input.ranges, ...input.breaks]) if (r.end_time <= r.start_time) throw Errors.invalid('invalid_hours', 'End time must be after start time');
  // Overlapping ranges on the same weekday are rejected (ambiguous schedule).
  for (let d = 0; d < 7; d++) {
    const day = input.ranges.filter((r) => r.weekday === d).sort((a, b) => a.start_time.localeCompare(b.start_time));
    for (let i = 1; i < day.length; i++) if (day[i]!.start_time < day[i - 1]!.end_time) throw Errors.invalid('overlapping_hours', 'Working ranges overlap');
  }
  return withTenant(access.tenantId, async (trx) => {
    const s = await trx.selectFrom('staff_profiles').select('id').where('id', '=', staffId).executeTakeFirst();
    if (!s) throw Errors.notFound('staff');
    await trx.deleteFrom('working_hours').where('staff_id', '=', staffId).where('branch_id', '=', input.branch_id).execute();
    if (input.ranges.length) {
      await trx.insertInto('working_hours').values(input.ranges.map((r) => ({ tenant_id: access.tenantId, staff_id: staffId, branch_id: input.branch_id, ...r }))).execute();
    }
    await trx.deleteFrom('staff_breaks').where('staff_id', '=', staffId).where('weekday', 'is not', null).execute();
    if (input.breaks.length) {
      await trx.insertInto('staff_breaks').values(input.breaks.map((b) => ({ tenant_id: access.tenantId, staff_id: staffId, weekday: b.weekday, start_time: b.start_time, end_time: b.end_time, label: b.label ?? null }))).execute();
    }
    await trx.insertInto('staff_branch_assignments').values({ tenant_id: access.tenantId, staff_id: staffId, branch_id: input.branch_id })
      .onConflict((oc) => oc.doNothing()).execute();
    await audit(trx, actor, 'schedule.weekly_set', { tenantId: access.tenantId, targetType: 'staff', targetId: staffId, data: { ranges: input.ranges.length, breaks: input.breaks.length } });
    return { staff_id: staffId };
  });
}

export async function addOverride(access: TenantAccess, actor: AuditActor, staffId: string, input: z.infer<typeof overrideInput>) {
  if (input.kind !== 'off' && (!input.start_time || !input.end_time || input.end_time <= input.start_time)) throw Errors.invalid('invalid_hours');
  return withTenant(access.tenantId, async (trx) => {
    const r = await trx.insertInto('shift_overrides').values({
      tenant_id: access.tenantId, staff_id: staffId, branch_id: input.branch_id, on_date: input.on_date, kind: input.kind,
      start_time: input.start_time ?? null, end_time: input.end_time ?? null, note: input.note ?? null, created_by: actor.userId,
    }).returningAll().executeTakeFirstOrThrow();
    await audit(trx, actor, 'schedule.override_added', { tenantId: access.tenantId, targetType: 'staff', targetId: staffId, data: { date: input.on_date, kind: input.kind } });
    return r;
  });
}

export async function deleteOverride(access: TenantAccess, actor: AuditActor, overrideId: string) {
  return withTenant(access.tenantId, async (trx) => {
    const r = await trx.deleteFrom('shift_overrides').where('id', '=', overrideId).returning('staff_id').executeTakeFirst();
    if (!r) throw Errors.notFound('override');
    await audit(trx, actor, 'schedule.override_removed', { tenantId: access.tenantId, targetType: 'staff', targetId: r.staff_id });
    return { deleted: true };
  });
}

export async function addTimeBlock(access: TenantAccess, actor: AuditActor, input: z.infer<typeof timeBlockInput>) {
  if (!!input.staff_id === !!input.resource_id) throw Errors.invalid('invalid_target', 'Choose either a team member or a resource');
  const from = new Date(input.starts_at), to = new Date(input.ends_at);
  if (to <= from) throw Errors.invalid('invalid_range');
  return withTenant(access.tenantId, async (trx) => {
    const r = await trx.insertInto('time_blocks').values({
      tenant_id: access.tenantId, branch_id: input.branch_id, staff_id: input.staff_id ?? null, resource_id: input.resource_id ?? null,
      during: `[${from.toISOString()},${to.toISOString()})`, reason: input.reason ?? null, created_by: actor.userId,
    }).returningAll().executeTakeFirstOrThrow();
    await audit(trx, actor, 'schedule.time_blocked', { tenantId: access.tenantId, targetType: input.staff_id ? 'staff' : 'resource', targetId: input.staff_id ?? input.resource_id });
    return r;
  });
}

export async function deleteTimeBlock(access: TenantAccess, actor: AuditActor, id: string) {
  return withTenant(access.tenantId, async (trx) => {
    const r = await trx.deleteFrom('time_blocks').where('id', '=', id).returning('id').executeTakeFirst();
    if (!r) throw Errors.notFound('block');
    await audit(trx, actor, 'schedule.time_unblocked', { tenantId: access.tenantId, targetType: 'time_block', targetId: id });
    return { deleted: true };
  });
}

// ── Leave ───────────────────────────────────────────────────────────────────
export async function requestLeave(access: TenantAccess, actor: AuditActor, input: z.infer<typeof leaveInput>) {
  const staffId = input.staff_id ?? access.staffProfileId;
  if (!staffId) throw Errors.invalid('staff_required');
  if (staffId !== access.staffProfileId && !hasCapability(access, 'schedule.manage')) throw Errors.notFound('staff');
  const from = new Date(input.starts_at), to = new Date(input.ends_at);
  if (to <= from) throw Errors.invalid('invalid_range');
  return withTenant(access.tenantId, async (trx) => {
    const r = await trx.insertInto('leave_requests').values({
      tenant_id: access.tenantId, staff_id: staffId, during: `[${from.toISOString()},${to.toISOString()})`,
      leave_type: input.leave_type, reason: input.reason ?? null, requested_by: actor.userId,
    }).returningAll().executeTakeFirstOrThrow();
    await notifyCapability(trx, access.tenantId, ['leave.approve'], {
      kind: 'leave.requested', title_ar: 'طلب إجازة جديد', title_en: 'New leave request', target_path: `/app/${access.slug}/team?tab=leave`, data: { leave_id: r.id },
    });
    await audit(trx, actor, 'leave.requested', { tenantId: access.tenantId, targetType: 'leave', targetId: r.id });
    return r;
  });
}

/**
 * Approving leave that overlaps booked appointments does not silently cancel
 * them: the affected bookings are recorded and management is alerted to act.
 */
export async function decideLeave(access: TenantAccess, actor: AuditActor, leaveId: string, input: z.infer<typeof leaveDecision>) {
  return withTenant(access.tenantId, async (trx) => {
    const lr = await trx.selectFrom('leave_requests').selectAll()
      .select([sql<Date>`lower(during)`.as('from_at'), sql<Date>`upper(during)`.as('to_at')])
      .where('id', '=', leaveId).forUpdate().executeTakeFirst();
    if (!lr) throw Errors.notFound('leave');
    if (lr.status !== 'requested') throw Errors.conflict('already_decided');
    let affected: string[] = [];
    if (input.decision === 'approved') {
      affected = await futureBookingsFor(trx, lr.staff_id, { from: lr.from_at, to: lr.to_at });
    }
    await trx.updateTable('leave_requests').set({
      status: input.decision, decided_by: actor.userId, decided_at: new Date(), decision_note: input.note ?? null, affected_booking_ids: affected,
    }).where('id', '=', leaveId).execute();
    await notifyStaff(trx, access.tenantId, lr.staff_id, {
      kind: `leave.${input.decision}`, title_ar: input.decision === 'approved' ? 'تمت الموافقة على إجازتك' : 'تم رفض طلب الإجازة',
      title_en: input.decision === 'approved' ? 'Your leave was approved' : 'Your leave request was declined', target_path: '/staff',
    });
    if (affected.length) {
      await notifyCapability(trx, access.tenantId, ['bookings.manage'], {
        kind: 'leave.affects_bookings', title_ar: `إجازة معتمدة تتعارض مع ${affected.length} مواعيد`, title_en: `Approved leave conflicts with ${affected.length} appointments`,
        target_path: `/app/${access.slug}/bookings?staff=${lr.staff_id}&upcoming=1`, data: { booking_ids: affected, leave_id: leaveId },
      });
    }
    await audit(trx, actor, `leave.${input.decision}`, { tenantId: access.tenantId, targetType: 'leave', targetId: leaveId, data: { affected_bookings: affected.length } });
    return { id: leaveId, status: input.decision, affected_booking_ids: affected };
  });
}

export async function listLeave(access: TenantAccess, status?: string) {
  return withTenant(access.tenantId, async (trx) => {
    let q = trx.selectFrom('leave_requests as l').innerJoin('staff_profiles as s', 's.id', 'l.staff_id').select(['l.id', 'l.staff_id', 's.display_name', 'l.during', 'l.leave_type', 'l.status', 'l.reason', 'l.affected_booking_ids', 'l.created_at']);
    if (!hasCapability(access, ['leave.approve', 'schedule.manage'])) {
      if (!access.staffProfileId) return [];
      q = q.where('l.staff_id', '=', access.staffProfileId);
    }
    if (status) q = q.where('l.status', '=', status);
    return q.orderBy('l.created_at', 'desc').limit(100).execute();
  });
}

// ── Attendance ──────────────────────────────────────────────────────────────
export async function clock(access: TenantAccess, actor: AuditActor, kind: 'clock_in' | 'clock_out', opts: { staffId?: string; note?: string } = {}) {
  const staffId = opts.staffId ?? access.staffProfileId;
  if (!staffId) throw Errors.invalid('staff_required', 'Your account is not linked to a staff profile');
  const forOther = staffId !== access.staffProfileId;
  if (forOther && !hasCapability(access, 'attendance.manage')) throw Errors.notFound('staff');
  if (!forOther && !hasCapability(access, 'attendance.own')) throw Errors.forbidden();
  return withTenant(access.tenantId, async (trx) => {
    const last = await trx.selectFrom('attendance_events').select(['kind']).where('staff_id', '=', staffId).orderBy('at', 'desc').limit(1).executeTakeFirst();
    if (kind === 'clock_in' && last?.kind === 'clock_in') throw Errors.conflict('already_clocked_in');
    if (kind === 'clock_out' && last?.kind !== 'clock_in') throw Errors.conflict('not_clocked_in');
    const r = await trx.insertInto('attendance_events').values({
      tenant_id: access.tenantId, staff_id: staffId, kind, source: forOther ? 'manager' : 'portal', note: opts.note ?? null, recorded_by: actor.userId,
    }).returningAll().executeTakeFirstOrThrow();
    return r;
  });
}

export async function attendance(access: TenantAccess, staffId: string | null, from: Date, to: Date) {
  const target = staffId ?? access.staffProfileId;
  if (!target && !hasCapability(access, 'attendance.manage')) throw Errors.forbidden();
  if (target && target !== access.staffProfileId && !hasCapability(access, 'attendance.manage')) throw Errors.notFound('staff');
  return withTenant(access.tenantId, (trx) => {
    let q = trx.selectFrom('attendance_events').selectAll().where('at', '>=', from).where('at', '<', to);
    if (target) q = q.where('staff_id', '=', target);
    return q.orderBy('at').execute();
  });
}
