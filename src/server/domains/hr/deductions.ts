import { DateTime } from 'luxon';
import { sql } from 'kysely';
import { z } from 'zod';
import { withSystem, withTenant, type Tx } from '../../db/client';
import { Errors } from '../../http/errors';
import { audit, type AuditActor } from '../../infra/audit';
import { notifyCapability, notifyStaff } from '../../infra/notify';
import { hasCapability, type TenantAccess } from '../../tenancy/access';
import { recordPayrollEntry } from '../payroll/service';
import { loadHrSettings, loadPay, loadSchedules, openPayrollStart, todayIn } from './common';
import { dailyWage, datesBetween, lateMinutes, latenessDeduction, leaveDayCount, localDatesOf, scheduledWindows } from './rules';

/**
 * Lateness and absence, and the deduction suggestions they produce.
 *
 *  - The scheduled shift of a day is the staff member's working windows
 *    (weekly hours ± date overrides − breaks); its start is the first window.
 *  - Late = first clock-in of the day after start + grace (default 10 min);
 *    the whole delay counts once the grace is exceeded.
 *  - Absent = a past scheduled working day without any clock-in and without
 *    approved leave overlapping it.
 *  - Day value = monthly base ÷ days in that month. Lateness = day value ÷
 *    scheduled minutes × minutes late (capped at a day). Absence = one day.
 *  - Unpaid leave = working days × day value, one suggestion per month.
 *
 * Suggestions are only produced for staff who use the attendance clock (have
 * at least one clock event) and have a base salary; days before the hire date,
 * after the end date, or inside a closed payroll month are skipped. The owner
 * approves or rejects each one in payroll; an approved one becomes a payroll
 * deduction. Pending suggestions block closing the month.
 */

export type DayRow = {
  staff_id: string; date: string; scheduled_start: string | null; scheduled_minutes: number;
  first_in: string | null; late_minutes: number; absent: boolean; on_leave: boolean;
};

const MIN = 60_000;

/** Per staff and local date: the scheduled start, first clock-in, lateness and absence. */
export async function analyzeAttendance(trx: Tx, tz: string, staffIds: string[], from: string, to: string, graceMin: number, now = new Date()): Promise<DayRow[]> {
  if (!staffIds.length) return [];
  const today = DateTime.fromJSDate(now, { zone: tz }).toISODate()!;
  const last = to < today ? to : today;
  if (last < from) return [];
  const dates = datesBetween(from, last);
  const scheds = await loadSchedules(trx, staffIds, from, last);
  const rangeStart = DateTime.fromISO(from, { zone: tz }).startOf('day').toJSDate();
  const rangeEnd = DateTime.fromISO(last, { zone: tz }).plus({ days: 1 }).startOf('day').toJSDate();
  const [events, leaves] = await Promise.all([
    trx.selectFrom('attendance_events').select(['staff_id', 'kind', 'at']).where('staff_id', 'in', staffIds).where('kind', '=', 'clock_in')
      .where('at', '>=', rangeStart).where('at', '<', rangeEnd).orderBy('at').execute(),
    trx.selectFrom('leave_requests').select(['staff_id', sql<Date>`lower(during)`.as('s'), sql<Date>`upper(during)`.as('e')])
      .where('staff_id', 'in', staffIds).where('status', '=', 'approved').where(sql<boolean>`during && tstzrange(${rangeStart}, ${rangeEnd})`).execute(),
  ]);
  const out: DayRow[] = [];
  for (const staffId of staffIds) {
    const s = scheds[staffId]!;
    for (const date of dates) {
      const windows = scheduledWindows(tz, s, date);
      if (!windows.length) continue;
      const start = windows[0]!.start;
      const end = windows[windows.length - 1]!.end;
      const minutes = windows.reduce((a, w) => a + (w.end - w.start) / MIN, 0);
      const onLeave = leaves.some((l) => l.staff_id === staffId && l.s.getTime() < end && l.e.getTime() > start);
      const dayStart = DateTime.fromISO(date, { zone: tz }).startOf('day').toMillis();
      const dayEnd = DateTime.fromISO(date, { zone: tz }).plus({ days: 1 }).startOf('day').toMillis();
      const firstIn = events.find((e) => e.staff_id === staffId && e.at.getTime() >= dayStart && e.at.getTime() < dayEnd);
      const late = !onLeave && firstIn ? lateMinutes(start, firstIn.at.getTime(), graceMin) : 0;
      // A day counts as an absence once it is over (or its shift has ended) without a clock-in.
      const over = date < today || end <= now.getTime();
      out.push({
        staff_id: staffId, date, scheduled_start: new Date(start).toISOString(), scheduled_minutes: minutes,
        first_in: firstIn ? firstIn.at.toISOString() : null, late_minutes: late, absent: !onLeave && !firstIn && over, on_leave: onLeave,
      });
    }
  }
  return out;
}

export const attendanceReportInput = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  staff_id: z.string().uuid().optional(),
});

/** Late/absent flags for the attendance views and the staff portal. Staff see only their own. */
export async function attendanceReport(access: TenantAccess, input: z.infer<typeof attendanceReportInput>) {
  if (input.to < input.from || datesBetween(input.from, input.to).length > 62) throw Errors.invalid('invalid_range', 'Choose up to two months');
  const manage = hasCapability(access, 'attendance.manage');
  const target = input.staff_id ?? (manage ? null : access.staffProfileId);
  if (!manage && (!target || target !== access.staffProfileId)) throw Errors.notFound('staff');
  return withTenant(access.tenantId, async (trx) => {
    const settings = await loadHrSettings(trx);
    const ids = target ? [target] : (await trx.selectFrom('staff_profiles').select('id').where('archived_at', 'is', null).where('is_active', '=', true).execute()).map((s) => s.id);
    const days = await analyzeAttendance(trx, access.timezone, ids, input.from, input.to, settings.grace_minutes);
    return { grace_minutes: settings.grace_minutes, days: days.filter((d) => d.late_minutes > 0 || d.absent || d.first_in || d.on_leave) };
  });
}

/**
 * Creates lateness/absence suggestions for [from, to] (idempotent per staff,
 * day and kind). Returns how many were created.
 */
export async function scanAttendanceTx(trx: Tx, tenantId: string, tz: string, from: string, to: string, now = new Date()) {
  const settings = await loadHrSettings(trx);
  if (!settings.attendance_deductions) return 0;
  const open = await openPayrollStart(trx);
  const lower = open && open > from ? open : from;
  if (to < lower) return 0;
  // Staff who use the clock and have a salary.
  const staff = await trx.selectFrom('staff_profiles as sp').innerJoin('staff_pay_profiles as pp', 'pp.staff_id', 'sp.id')
    .select(['sp.id']).where('sp.archived_at', 'is', null).where('pp.base_salary_minor', '>', 0)
    .where(sql<boolean>`exists (select 1 from attendance_events a where a.staff_id = sp.id)`).execute();
  const ids = staff.map((s) => s.id);
  if (!ids.length) return 0;
  const pay = await loadPay(trx, ids);
  const days = await analyzeAttendance(trx, tz, ids, lower, to, settings.grace_minutes, now);
  let created = 0;
  for (const d of days) {
    const p = pay.get(d.staff_id)!;
    if ((p.hire && d.date < p.hire) || (p.end && d.date > p.end)) continue;
    const dim = DateTime.fromISO(d.date).daysInMonth!;
    let row: { source: 'lateness' | 'absence'; minutes: number | null; days: number | null; amount: number; key: string } | null = null;
    if (d.absent) row = { source: 'absence', minutes: null, days: 1, amount: dailyWage(p.base, dim), key: `absence:${d.staff_id}:${d.date}` };
    else if (d.late_minutes > 0) row = { source: 'lateness', minutes: d.late_minutes, days: null, amount: latenessDeduction(p.base, dim, d.scheduled_minutes, d.late_minutes), key: `lateness:${d.staff_id}:${d.date}` };
    if (!row || row.amount <= 0) continue;
    const ins = await trx.insertInto('payroll_deduction_suggestions').values({
      tenant_id: tenantId, staff_id: d.staff_id, source: row.source, on_date: d.date, minutes: row.minutes, days: row.days, amount_minor: row.amount,
      basis: JSON.stringify({ base_salary_minor: p.base, days_in_month: dim, day_value_minor: dailyWage(p.base, dim), scheduled_start: d.scheduled_start, scheduled_minutes: d.scheduled_minutes, first_in: d.first_in, grace_minutes: settings.grace_minutes }),
      dedupe_key: row.key,
    }).onConflict((oc) => oc.columns(['tenant_id', 'dedupe_key']).doNothing()).returning('id').executeTakeFirst();
    if (ins) created++;
  }
  if (created) {
    await notifyCapability(trx, tenantId, ['payroll.manage'], {
      kind: 'payroll.suggestions_pending', title_ar: `${created} اقتراح خصم جديد (تأخير/غياب) بانتظار اعتمادك`, title_en: `${created} new deduction suggestions (lateness/absence) to review`,
      target_path: `/app/${(await trx.selectFrom('tenants').select('slug').where('id', '=', tenantId).executeTakeFirstOrThrow()).slug}/payroll?tab=suggestions`,
      dedupe_key: `payroll-suggestions:${to}`,
    });
  }
  return created;
}

/** Unpaid leave: one suggestion per calendar month the leave touches (working days × day value). */
export async function createUnpaidLeaveSuggestions(trx: Tx, access: TenantAccess, v: { staffId: string; leaveRequestId: string; hrRequestId: string | null; from: Date; to: Date }) {
  const pay = (await loadPay(trx, [v.staffId])).get(v.staffId);
  if (!pay || pay.base <= 0) return 0;
  const dates = localDatesOf(v.from, v.to, access.timezone);
  if (!dates.length) return 0;
  const sched = (await loadSchedules(trx, [v.staffId], dates[0]!, dates[dates.length - 1]!))[v.staffId]!;
  const byMonth = new Map<string, string[]>();
  for (const d of dates) byMonth.set(d.slice(0, 7), [...(byMonth.get(d.slice(0, 7)) ?? []), d]);
  let n = 0;
  for (const [month, ds] of byMonth) {
    const days = leaveDayCount(access.timezone, sched, ds);
    const dim = DateTime.fromISO(`${month}-01`).daysInMonth!;
    const amount = Math.round((pay.base * days) / dim);
    if (days <= 0 || amount <= 0) continue;
    await trx.insertInto('payroll_deduction_suggestions').values({
      tenant_id: access.tenantId, staff_id: v.staffId, source: 'unpaid_leave', on_date: ds[0]!, days, amount_minor: amount, hr_request_id: v.hrRequestId,
      basis: JSON.stringify({ base_salary_minor: pay.base, days_in_month: dim, day_value_minor: dailyWage(pay.base, dim), leave_request_id: v.leaveRequestId, dates: ds }),
      dedupe_key: `unpaid:${v.leaveRequestId}:${month}`,
    }).onConflict((oc) => oc.columns(['tenant_id', 'dedupe_key']).doNothing()).execute();
    n++;
  }
  return n;
}

// ── Payroll review ──────────────────────────────────────────────────────────
export const suggestionListInput = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  status: z.enum(['pending', 'approved', 'rejected']).optional(),
});

export async function listSuggestions(access: TenantAccess, input: z.infer<typeof suggestionListInput>) {
  const start = `${input.month}-01`;
  const end = DateTime.fromISO(start).endOf('month').toISODate()!;
  return withTenant(access.tenantId, async (trx) => {
    let q = trx.selectFrom('payroll_deduction_suggestions as d').innerJoin('staff_profiles as s', 's.id', 'd.staff_id')
      .select(['d.id', 'd.staff_id', 's.display_name as staff_name', 'd.source', 'd.on_date', 'd.minutes', 'd.days', 'd.amount_minor', 'd.basis', 'd.status',
        'd.payroll_entry_id', 'd.decided_at', 'd.decision_note', 'd.created_at'])
      .where('d.on_date', '<=', end);
    // Pending ones from earlier open months stay visible until decided.
    q = q.where((w) => w.or([w('d.on_date', '>=', start), w('d.status', '=', 'pending')]));
    if (input.status) q = q.where('d.status', '=', input.status);
    return q.orderBy('d.on_date').orderBy('s.display_name').limit(1000).execute();
  });
}

export const suggestionDecisionInput = z.object({
  ids: z.array(z.string().uuid()).min(1).max(200),
  decision: z.enum(['approved', 'rejected']),
  note: z.string().trim().max(500).optional(),
}).strict();

/** Approve (→ payroll deduction) or reject suggestions, in bulk. */
export async function decideSuggestions(access: TenantAccess, actor: AuditActor, input: z.infer<typeof suggestionDecisionInput>) {
  return withTenant(access.tenantId, async (trx) => {
    const rows = await trx.selectFrom('payroll_deduction_suggestions').selectAll().where('id', 'in', input.ids).forUpdate().execute();
    if (rows.length !== new Set(input.ids).size) throw Errors.notFound('suggestion');
    if (rows.some((r) => r.status !== 'pending')) throw Errors.conflict('already_decided', 'Some suggestions were already decided');
    const open = await openPayrollStart(trx);
    const today = todayIn(access.timezone);
    let entries = 0;
    for (const r of rows) {
      let entryId: string | null = null;
      if (input.decision === 'approved') {
        const label = r.source === 'lateness' ? `تأخير ${r.minutes} دقيقة — ${r.on_date}` : r.source === 'absence' ? `غياب — ${r.on_date}` : `إجازة بدون راتب — ${Number(r.days)} يوم`;
        const e = await recordPayrollEntry(trx, access, actor, {
          staff_id: r.staff_id, kind: 'deduction', amount_minor: r.amount_minor, effective_on: open && r.on_date < open ? today : r.on_date, note: input.note ? `${label} · ${input.note}` : label,
        });
        entryId = e.id;
        entries++;
      }
      await trx.updateTable('payroll_deduction_suggestions').set({ status: input.decision, payroll_entry_id: entryId, decided_by: actor.userId, decided_at: new Date(), decision_note: input.note ?? null })
        .where('id', '=', r.id).execute();
      if (input.decision === 'approved') {
        await notifyStaff(trx, access.tenantId, r.staff_id, {
          kind: 'payroll.deduction_approved', title_ar: 'تم اعتماد خصم على راتبك', title_en: 'A deduction was applied to your salary', target_path: `/app/${access.slug}/me`, data: { suggestion_id: r.id },
        });
      }
    }
    await audit(trx, actor, `payroll.suggestions_${input.decision}`, { tenantId: access.tenantId, targetType: 'payroll_deduction_suggestion', targetId: rows[0]!.id, data: { ids: input.ids, entries } });
    return { decided: rows.length, entries };
  });
}

/** Scans attendance for a month (up to today) and returns the number of new suggestions. */
export async function scanMonth(access: TenantAccess, month: string) {
  const start = `${month}-01`;
  const end = DateTime.fromISO(start).endOf('month').toISODate()!;
  return withTenant(access.tenantId, async (trx) => ({ created: await scanAttendanceTx(trx, access.tenantId, access.timezone, start, end) }));
}

/** Periodic job: the last three days for every active business. */
export async function runAttendanceScan(now = new Date()) {
  const tenants = await withSystem('hr: businesses for attendance scan', (trx) => trx.selectFrom('tenants').select(['id', 'timezone']).where('status', 'in', ['active', 'onboarding']).execute());
  let created = 0;
  for (const t of tenants) {
    const tz = t.timezone;
    const to = DateTime.fromJSDate(now, { zone: tz }).minus({ days: 1 }).toISODate()!;
    const from = DateTime.fromJSDate(now, { zone: tz }).minus({ days: 3 }).toISODate()!;
    created += await withTenant(t.id, (trx) => scanAttendanceTx(trx, t.id, tz, from, to, now));
  }
  return { created };
}
