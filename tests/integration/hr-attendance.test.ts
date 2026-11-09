import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { makeSalon, TZ } from '../helpers/salon';
import { clockInAt, dayOffset, member, setPay, today } from '../helpers/hr';
import { withTenant } from '@/server/db/client';
import { dailyWage, latenessDeduction } from '@/server/domains/hr/rules';
import { runAttendanceScan } from '@/server/domains/hr/deductions';
import * as report from '@/app/api/v1/t/[tenantSlug]/hr/attendance/route';
import * as suggestions from '@/app/api/v1/t/[tenantSlug]/payroll/suggestions/route';
import * as scan from '@/app/api/v1/t/[tenantSlug]/payroll/suggestions/scan/route';
import * as sheet from '@/app/api/v1/t/[tenantSlug]/payroll/sheet/route';
import * as close from '@/app/api/v1/t/[tenantSlug]/payroll/close/route';
import * as types from '@/app/api/v1/t/[tenantSlug]/hr/request-types/route';
import * as requests from '@/app/api/v1/t/[tenantSlug]/hr/requests/route';
import * as decide from '@/app/api/v1/t/[tenantSlug]/hr/requests/[id]/decide/route';

const monthOf = (d: string) => d.slice(0, 7);
const dim = (d: string) => DateTime.fromISO(d).daysInMonth!;

describe('lateness and absence', () => {
  it('flags late and absent days against the schedule, suggests deductions the owner approves or rejects in payroll, and blocks closing until decided', async () => {
    const s = await makeSalon();
    const p = { tenantSlug: s.slug };
    const base = 300000;
    // Hired four days ago; works 10:00–18:00 every day (480 minutes).
    const d4 = dayOffset(-4), d3 = dayOffset(-3), d2 = dayOffset(-2), d1 = dayOffset(-1);
    await setPay(s, s.staff.sara, base, d4);
    await setPay(s, s.staff.huda, base, d4);
    const sara = await member(s, 'specialist', s.staff.sara);
    // d4: no clock-in → absent. d3: approved leave → nothing. d2: 5 minutes late (within grace). d1: 25 minutes late. Today: on time.
    await withTenant(s.tenantId, (trx) => trx.insertInto('leave_requests').values({
      tenant_id: s.tenantId, staff_id: s.staff.sara, status: 'approved', leave_type: 'sick',
      during: `[${DateTime.fromISO(d3, { zone: TZ }).toISO()},${DateTime.fromISO(d3, { zone: TZ }).plus({ days: 1 }).toISO()})`,
    }).execute());
    await clockInAt(s, s.staff.sara, d2, '10:05');
    await clockInAt(s, s.staff.sara, d1, '10:25');
    await clockInAt(s, s.staff.sara, today(), '10:00');

    const flags = (await s.owner.call(report.GET, { params: p, query: { from: d4, to: today(), staff_id: s.staff.sara } })).body.data;
    expect(flags.grace_minutes).toBe(10);
    const day = (d: string) => flags.days.find((x: any) => x.date === d);
    expect(day(d4)).toMatchObject({ absent: true, late_minutes: 0 });
    expect(day(d3)).toMatchObject({ on_leave: true, absent: false });
    expect(day(d2)).toMatchObject({ late_minutes: 0, absent: false });
    expect(day(d1)).toMatchObject({ late_minutes: 25, absent: false, scheduled_minutes: 480 });
    // Staff see their own flags only.
    expect((await sara.call(report.GET, { params: p, query: { from: d4, to: today() } })).body.data.days.length).toBeGreaterThan(0);
    expect((await sara.call(report.GET, { params: p, query: { from: d4, to: today(), staff_id: s.staff.huda } })).status).toBe(404);

    // Scan the months involved (idempotent) — Huda never uses the clock, so nothing is suggested for her.
    const months = [...new Set([d4, d1, today()].map(monthOf))];
    let created = 0;
    for (const m of months) created += (await s.owner.call(scan.POST, { params: p, body: { month: m } })).body.data.created;
    expect(created).toBe(2);
    for (const m of months) expect((await s.owner.call(scan.POST, { params: p, body: { month: m } })).body.data.created).toBe(0);
    await runAttendanceScan();

    const all = (await Promise.all(months.map(async (m) => (await s.owner.call(suggestions.GET, { params: p, query: { month: m } })).body.data))).flat();
    const unique = [...new Map(all.map((x: any) => [x.id, x])).values()] as any[];
    expect(unique).toHaveLength(2);
    const late = unique.find((x) => x.source === 'lateness');
    const absent = unique.find((x) => x.source === 'absence');
    expect(late).toMatchObject({ staff_id: s.staff.sara, on_date: d1, minutes: 25, amount_minor: latenessDeduction(base, dim(d1), 480, 25), status: 'pending' });
    expect(absent).toMatchObject({ staff_id: s.staff.sara, on_date: d4, days: 1, amount_minor: dailyWage(base, dim(d4)) });

    // The month cannot close while suggestions are pending.
    const cur = (await s.owner.call(sheet.GET, { params: p, query: { month: monthOf(d4) } })).body.data;
    expect(cur.close).toMatchObject({ allowed: false, blocker: 'payroll_suggestions_pending' });
    expect((await s.owner.call(close.POST, { params: p, body: { month: monthOf(d4) } })).body.error.code).toBe('payroll_suggestions_pending');

    const reception = await member(s, 'receptionist');
    expect((await reception.call(suggestions.POST, { params: p, body: { ids: [late.id], decision: 'approved' } })).status).toBe(403);
    expect((await sara.call(suggestions.GET, { params: p, query: { month: monthOf(d1) } })).status).toBe(403);
    const ok = await s.owner.call(suggestions.POST, { params: p, body: { ids: [late.id], decision: 'approved' } });
    expect(ok.body.data).toEqual({ decided: 1, entries: 1 });
    expect((await s.owner.call(suggestions.POST, { params: p, body: { ids: [late.id], decision: 'rejected' } })).body.error.code).toBe('already_decided');
    expect((await s.owner.call(suggestions.POST, { params: p, body: { ids: [absent.id], decision: 'rejected', note: 'عذر مقبول' } })).body.data).toEqual({ decided: 1, entries: 0 });

    const row = (await s.owner.call(sheet.GET, { params: p, query: { month: monthOf(d1) } })).body.data.rows.find((r: any) => r.staff_id === s.staff.sara);
    expect(row.deduction_minor).toBe(late.amount_minor);
    expect(row.entries.find((e: any) => e.kind === 'deduction').note).toContain('تأخير 25 دقيقة');
    const after = (await s.owner.call(sheet.GET, { params: p, query: { month: monthOf(d4) } })).body.data;
    expect(after.close.blocker).not.toBe('payroll_suggestions_pending');
  });

  it('suggests the unpaid leave deduction (working days × monthly base ÷ days in month) when unpaid leave is approved', async () => {
    const s = await makeSalon();
    const p = { tenantSlug: s.slug };
    const base = 310000;
    await setPay(s, s.staff.sara, base, dayOffset(-400));
    const sara = await member(s, 'specialist', s.staff.sara);
    const unpaid = (await sara.call(types.GET, { params: p })).body.data.find((t: any) => t.code === 'unpaid_leave').id;
    const from = dayOffset(10), to = dayOffset(11);
    const r = await sara.call(requests.POST, { params: p, body: { type_id: unpaid, starts_on: from, ends_on: to } });
    expect(r.status).toBe(201);
    await s.owner.call(decide.POST, { params: { ...p, id: r.body.data.id }, body: { decision: 'approved' } });
    const months = [...new Set([from, to].map(monthOf))];
    const rows = (await Promise.all(months.map(async (m) => (await s.owner.call(suggestions.GET, { params: p, query: { month: m } })).body.data))).flat()
      .filter((x: any, i: number, arr: any[]) => arr.findIndex((y) => y.id === x.id) === i);
    expect(rows.every((x: any) => x.source === 'unpaid_leave')).toBe(true);
    const expected = months.reduce((a, m) => a + Math.round((base * [from, to].filter((d) => monthOf(d) === m).length) / dim(`${m}-01`)), 0);
    expect(rows.reduce((a: number, x: any) => a + x.amount_minor, 0)).toBe(expected);
    expect(rows.reduce((a: number, x: any) => a + x.days, 0)).toBe(2);
    // The suggestion waits for the owner like the others.
    expect(rows.every((x: any) => x.status === 'pending')).toBe(true);
  });
});
