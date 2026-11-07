import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import {
  accruedLeaveDays, completedMonths, dailyWage, expiryThreshold, lateMinutes, latenessDeduction, leaveDayCount, localDatesOf, maskIdNumber, yearlyEntitlement,
} from '@/server/domains/hr/rules';
import type { StaffSchedule } from '@/server/domains/booking/engine';

describe('annual leave accrual', () => {
  it('accrues 1.75 days per completed month (21 a year) and carries over', () => {
    expect(completedMonths('2025-01-15', '2025-02-14')).toBe(0);
    expect(completedMonths('2025-01-15', '2025-02-15')).toBe(1);
    expect(accruedLeaveDays('2025-01-15', '2025-02-15')).toBe(1.75);
    expect(accruedLeaveDays('2025-01-15', '2026-01-15')).toBe(21);
    expect(accruedLeaveDays('2025-01-15', '2027-01-15')).toBe(42);
    // Hire on the 31st: the month completes on the last day of a shorter month.
    expect(completedMonths('2026-01-31', '2026-02-28')).toBe(1);
    expect(accruedLeaveDays('2026-05-01', '2026-04-01')).toBe(0);
  });

  it('accrues 2.5 days per month (30 a year) after five years of service', () => {
    expect(accruedLeaveDays('2020-01-01', '2025-01-01')).toBe(105);
    expect(accruedLeaveDays('2020-01-01', '2025-02-01')).toBe(107.5);
    expect(accruedLeaveDays('2020-01-01', '2026-01-01')).toBe(135);
    expect(yearlyEntitlement('2020-01-01', '2024-12-31')).toBe(21);
    expect(yearlyEntitlement('2020-01-01', '2025-01-01')).toBe(30);
    expect(yearlyEntitlement(null, '2025-01-01')).toBe(21);
  });
});

describe('lateness and wages', () => {
  const start = DateTime.fromISO('2026-11-01T10:00', { zone: 'Asia/Riyadh' }).toMillis();
  const at = (m: number) => start + m * 60_000;
  it('counts nothing within the grace period and the whole delay beyond it', () => {
    expect(lateMinutes(start, at(-5), 10)).toBe(0);
    expect(lateMinutes(start, at(10), 10)).toBe(0);
    expect(lateMinutes(start, at(10.5), 10)).toBe(0);
    expect(lateMinutes(start, at(11), 10)).toBe(11);
    expect(lateMinutes(start, at(25), 0)).toBe(25);
  });
  it('values a day as base ÷ days in month and a late minute as a share of the scheduled day', () => {
    expect(dailyWage(300000, 30)).toBe(10000);
    expect(dailyWage(310000, 31)).toBe(10000);
    // 8h shift (480 min), day value 10,000 → 30 min late = 625.
    expect(latenessDeduction(300000, 30, 480, 30)).toBe(625);
    expect(latenessDeduction(300000, 30, 480, 0)).toBe(0);
    // Capped at a day's wage.
    expect(latenessDeduction(300000, 30, 60, 600)).toBe(10000);
  });
});

describe('leave days and dates', () => {
  const sched = (weekdays: number[]): StaffSchedule => ({
    staffId: 's', sort: 0, busy: [], breaks: [], overrides: [],
    weekly: weekdays.map((weekday) => ({ weekday, start: '10:00', end: '18:00', effectiveFrom: null, effectiveTo: null })),
  });
  it('counts scheduled working days, or calendar days without a schedule', () => {
    // 2026-11-01 is a Sunday; Sunday–Thursday working week.
    const dates = ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07'];
    expect(leaveDayCount('Asia/Riyadh', sched([0, 1, 2, 3, 4]), dates)).toBe(5);
    expect(leaveDayCount('Asia/Riyadh', sched([]), dates)).toBe(7);
    const withOff: StaffSchedule = { ...sched([0, 1, 2, 3, 4]), overrides: [{ onDate: '2026-11-02', kind: 'off', start: null, end: null }] };
    expect(leaveDayCount('Asia/Riyadh', withOff, dates)).toBe(4);
  });
  it('turns an instant range into local dates (end exclusive)', () => {
    const from = DateTime.fromISO('2026-11-01T00:00', { zone: 'Asia/Riyadh' }).toJSDate();
    expect(localDatesOf(from, DateTime.fromISO('2026-11-03T00:00', { zone: 'Asia/Riyadh' }).toJSDate(), 'Asia/Riyadh')).toEqual(['2026-11-01', '2026-11-02']);
    expect(localDatesOf(from, DateTime.fromISO('2026-11-01T23:59', { zone: 'Asia/Riyadh' }).toJSDate(), 'Asia/Riyadh')).toEqual(['2026-11-01']);
  });
});

describe('staff file helpers', () => {
  it('alerts at 60, 30 and 7 days before expiry', () => {
    expect(expiryThreshold('2026-12-31', '2026-10-01')).toBeNull();
    expect(expiryThreshold('2026-12-31', '2026-11-01')).toBe(60);
    expect(expiryThreshold('2026-12-31', '2026-12-01')).toBe(30);
    expect(expiryThreshold('2026-12-31', '2026-12-24')).toBe(7);
    expect(expiryThreshold('2026-12-31', '2026-12-31')).toBe(7);
    expect(expiryThreshold('2026-12-31', '2027-01-01')).toBeNull();
  });
  it('masks identity numbers', () => {
    expect(maskIdNumber('2123456789')).toBe('••••••6789');
    expect(maskIdNumber('123')).toBe('•••');
    expect(maskIdNumber(null)).toBeNull();
  });
});
