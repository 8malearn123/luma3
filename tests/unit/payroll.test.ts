import { describe, expect, it } from 'vitest';
import { employedDays, installmentAmount, tierRate } from '@/server/domains/payroll/service';

describe('payroll rules', () => {
  it('uses the highest tier reached for all sales, the base rate below the first tier, and 0 when off', () => {
    const p = { enabled: true, rate_bp: 1000, tiers: [{ threshold_minor: 2000000, rate_bp: 2000 }, { threshold_minor: 1000000, rate_bp: 1500 }] };
    expect(tierRate(p, 999999)).toBe(1000);
    expect(tierRate(p, 1000000)).toBe(1500);
    expect(tierRate(p, 5000000)).toBe(2000);
    expect(tierRate({ ...p, enabled: false }, 5000000)).toBe(0);
  });
  it('counts calendar days employed within the month', () => {
    expect(employedDays('2026-11-01', '2026-11-30', null, null)).toBe(30);
    expect(employedDays('2026-11-01', '2026-11-30', '2026-11-11', null)).toBe(20);
    expect(employedDays('2026-11-01', '2026-11-30', null, '2026-11-15')).toBe(15);
    expect(employedDays('2026-11-01', '2026-11-30', '2026-11-10', '2026-11-10')).toBe(1);
    expect(employedDays('2026-11-01', '2026-11-30', '2026-12-01', null)).toBe(0);
    expect(employedDays('2026-11-01', '2026-11-30', null, '2026-10-31')).toBe(0);
  });
  it('splits an advance into instalments that add up exactly', () => {
    expect([0, 1, 2].map((k) => installmentAmount(100000, 3, k))).toEqual([33333, 33333, 33334]);
    expect(installmentAmount(5000, 1, 0)).toBe(5000);
  });
});
