import { DateTime } from 'luxon';
import { workingWindows, type EngineInput, type Range, type StaffSchedule } from '../booking/engine';

/**
 * Pure HR rules (unit-tested in tests/unit/hr-rules.test.ts).
 *
 * Annual leave: 21 days a year (1.75 a month) for the first five years of
 * service, 30 a year (2.5 a month) after. A month accrues when it is complete
 * (on the same day-of-month as the hire date). Unused days carry over.
 */
export const ACCRUAL_PER_MONTH = 1.75;
export const ACCRUAL_PER_MONTH_SENIOR = 2.5;
export const SENIOR_AFTER_MONTHS = 60;

/** Completed months of service between the hire date and asOf (both YYYY-MM-DD). */
export function completedMonths(hireDate: string, asOf: string) {
  const start = DateTime.fromISO(hireDate);
  const end = DateTime.fromISO(asOf);
  if (!start.isValid || !end.isValid || end < start) return 0;
  let m = (end.year - start.year) * 12 + (end.month - start.month);
  // Month m is complete when the anniversary day has been reached (clamped to the month's length).
  const anniversary = start.plus({ months: m });
  if (anniversary > end) m -= 1;
  return Math.max(0, m);
}

/** Annual leave accrued from the hire date up to asOf, in days (2 decimals). */
export function accruedLeaveDays(hireDate: string, asOf: string) {
  const m = completedMonths(hireDate, asOf);
  const days = Math.min(m, SENIOR_AFTER_MONTHS) * ACCRUAL_PER_MONTH + Math.max(0, m - SENIOR_AFTER_MONTHS) * ACCRUAL_PER_MONTH_SENIOR;
  return round2(days);
}

/** Yearly entitlement at a date: 21, or 30 after five full years of service. */
export function yearlyEntitlement(hireDate: string | null, asOf: string) {
  return hireDate && completedMonths(hireDate, asOf) >= SENIOR_AFTER_MONTHS ? 30 : 21;
}

export const round2 = (n: number) => Math.round(n * 100) / 100;

/** One day's wage: monthly base ÷ days in that month (minor units, rounded). */
export function dailyWage(baseMinor: number, daysInMonth: number) {
  return daysInMonth > 0 ? Math.round(baseMinor / daysInMonth) : 0;
}

/**
 * Minutes late after the scheduled start, or 0 within the grace period. Once
 * the grace period is exceeded the whole delay counts (a clock-in 12 minutes
 * late with 10 minutes' grace is 12 minutes late).
 */
export function lateMinutes(scheduledStartMs: number, clockInMs: number, graceMin: number) {
  const late = Math.floor((clockInMs - scheduledStartMs) / 60_000);
  return late > graceMin ? late : 0;
}

/**
 * Lateness deduction: the per-minute value of the daily wage (daily wage ÷
 * scheduled minutes that day) × minutes late, capped at the daily wage.
 */
export function latenessDeduction(baseMinor: number, daysInMonth: number, scheduledMinutes: number, minutesLate: number) {
  if (minutesLate <= 0 || scheduledMinutes <= 0) return 0;
  const daily = baseMinor / daysInMonth;
  return Math.min(Math.round(daily), Math.round((daily * minutesLate) / scheduledMinutes));
}

/** Local dates covered by a half-open instant range [from, to) in a timezone. */
export function localDatesOf(from: Date, to: Date, tz: string): string[] {
  const out: string[] = [];
  let d = DateTime.fromJSDate(from, { zone: tz }).startOf('day');
  const end = DateTime.fromJSDate(to, { zone: tz });
  for (let i = 0; d < end && i < 400; i++, d = d.plus({ days: 1 })) out.push(d.toISODate()!);
  return out;
}

/** Inclusive list of YYYY-MM-DD dates. */
export function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = DateTime.fromISO(from), i = 0; d.toISODate()! <= to && i < 400; d = d.plus({ days: 1 }), i++) out.push(d.toISODate()!);
  return out;
}

/** A minimal engine input: only the timezone matters for the schedule (branch hours are ignored for HR). */
export function scheduleOnlyInput(tz: string): EngineInput {
  return {
    tz, now: Date.now(), minNoticeMin: 0, maxAdvanceDays: 3650, slotIncrementMin: 15, maxGapMin: 0,
    anyStaffRule: 'earliest_then_staff_order', branchHours: [], staff: {}, resources: [], bookedMinutes: {},
  };
}

/** The staff member's scheduled working windows on a local date (weekly hours ± overrides − breaks). */
export function scheduledWindows(tz: string, s: StaffSchedule, dateISO: string): Range[] {
  return workingWindows(scheduleOnlyInput(tz), s, dateISO);
}

/**
 * Leave days counted against the balance: the staff member's scheduled working
 * days in the range (a day with no working hours, or a day-off override, does
 * not count). Without any weekly schedule, calendar days count.
 */
export function leaveDayCount(tz: string, s: StaffSchedule, dates: string[]) {
  if (!s.weekly.length) return dates.length;
  return dates.filter((d) => scheduledWindows(tz, s, d).length > 0).length;
}

/** The smallest alert threshold (60/30/7 days) reached by an expiry date, or null. */
export const EXPIRY_THRESHOLDS = [60, 30, 7] as const;
export function expiryThreshold(expiresOn: string, today: string): number | null {
  const left = Math.round(DateTime.fromISO(expiresOn).diff(DateTime.fromISO(today), 'days').days);
  if (left < 0) return null;
  let hit: number | null = null;
  for (const t of EXPIRY_THRESHOLDS) if (left <= t) hit = t;
  return hit;
}

/** Shows only the last 4 characters of an identity number. */
export function maskIdNumber(v: string | null) {
  if (!v) return null;
  return v.length <= 4 ? '•'.repeat(v.length) : `${'•'.repeat(v.length - 4)}${v.slice(-4)}`;
}
