import { DateTime } from 'luxon';
import type { Tx } from '../../db/client';
import { notifyUsers, type NotificationContent } from '../../infra/notify';
import type { StaffSchedule } from '../booking/engine';

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const CHAIN_ROLES = ['manager', 'owner', 'finance', 'receptionist'] as const;
export type ChainRole = (typeof CHAIN_ROLES)[number];

export type HrSettings = { grace_minutes: number; leave_balance_policy: 'block' | 'warn'; attendance_deductions: boolean };
export const DEFAULT_HR_SETTINGS: HrSettings = { grace_minutes: 10, leave_balance_policy: 'block', attendance_deductions: true };

export async function loadHrSettings(trx: Tx): Promise<HrSettings> {
  const r = await trx.selectFrom('hr_settings').select(['grace_minutes', 'leave_balance_policy', 'attendance_deductions']).executeTakeFirst();
  return r ? { grace_minutes: r.grace_minutes, leave_balance_policy: r.leave_balance_policy as HrSettings['leave_balance_policy'], attendance_deductions: r.attendance_deductions } : { ...DEFAULT_HR_SETTINGS };
}

/** Weekly hours (all branches), recurring and dated breaks and overrides for the staff members, for dates [from, to]. */
export async function loadSchedules(trx: Tx, staffIds: string[], from: string, to: string): Promise<Record<string, StaffSchedule>> {
  const out: Record<string, StaffSchedule> = {};
  if (!staffIds.length) return out;
  const [hours, breaks, overrides] = await Promise.all([
    trx.selectFrom('working_hours').selectAll().where('staff_id', 'in', staffIds).execute(),
    trx.selectFrom('staff_breaks').selectAll().where('staff_id', 'in', staffIds).execute(),
    trx.selectFrom('shift_overrides').selectAll().where('staff_id', 'in', staffIds).where('on_date', '>=', from).where('on_date', '<=', to).execute(),
  ]);
  for (const id of staffIds) {
    out[id] = {
      staffId: id, sort: 0,
      weekly: hours.filter((h) => h.staff_id === id).map((h) => ({ weekday: h.weekday, start: h.start_time.slice(0, 5), end: h.end_time.slice(0, 5), effectiveFrom: h.effective_from, effectiveTo: h.effective_to })),
      breaks: breaks.filter((b) => b.staff_id === id).map((b) => ({ weekday: b.weekday, onDate: b.on_date, start: b.start_time.slice(0, 5), end: b.end_time.slice(0, 5) })),
      overrides: overrides.filter((o) => o.staff_id === id).map((o) => ({ onDate: o.on_date, kind: o.kind as 'off' | 'replace' | 'extra', start: o.start_time?.slice(0, 5) ?? null, end: o.end_time?.slice(0, 5) ?? null })),
      busy: [],
    };
  }
  return out;
}

/** Hire dates (staff_pay_profiles.employment_start) and base salaries. */
export async function loadPay(trx: Tx, staffIds: string[]) {
  if (!staffIds.length) return new Map<string, { hire: string | null; end: string | null; base: number }>();
  const rows = await trx.selectFrom('staff_pay_profiles').select(['staff_id', 'employment_start', 'employment_end', 'base_salary_minor']).where('staff_id', 'in', staffIds).execute();
  return new Map(rows.map((r) => [r.staff_id, { hire: r.employment_start, end: r.employment_end, base: r.base_salary_minor }]));
}

/** Notifies every active member holding one of the roles. */
export async function notifyRoles(trx: Tx, tenantId: string, roles: string[], n: NotificationContent) {
  if (!roles.length) return;
  const rows = await trx.selectFrom('tenant_memberships').select('user_id').where('status', '=', 'active').where('role', 'in', roles).execute();
  await notifyUsers(trx, tenantId, rows.map((r) => r.user_id), n);
}

export const todayIn = (tz: string) => DateTime.now().setZone(tz).toISODate()!;

/** Start of the first payroll month that is still open (YYYY-MM-DD), or null when nothing is closed. */
export async function openPayrollStart(trx: Tx) {
  const r = await trx.selectFrom('payroll_runs').select('period_month').orderBy('period_month', 'desc').limit(1).executeTakeFirst();
  return r ? DateTime.fromISO(r.period_month).plus({ months: 1 }).toISODate()! : null;
}
