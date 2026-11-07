import { describe, expect, it } from 'vitest';
import { makeSalon } from '../helpers/salon';
import { dayOffset, member, now, setPay } from '../helpers/hr';
import { withTenant } from '@/server/db/client';
import * as balances from '@/app/api/v1/t/[tenantSlug]/hr/balances/route';
import * as balanceOne from '@/app/api/v1/t/[tenantSlug]/hr/balances/[staffId]/route';
import * as settings from '@/app/api/v1/t/[tenantSlug]/hr/settings/route';
import * as types from '@/app/api/v1/t/[tenantSlug]/hr/request-types/route';
import * as requests from '@/app/api/v1/t/[tenantSlug]/hr/requests/route';
import * as requestOne from '@/app/api/v1/t/[tenantSlug]/hr/requests/[id]/route';
import * as decide from '@/app/api/v1/t/[tenantSlug]/hr/requests/[id]/decide/route';
import * as cancel from '@/app/api/v1/t/[tenantSlug]/hr/requests/[id]/cancel/route';
import * as meHr from '@/app/api/v1/t/[tenantSlug]/me/hr/route';
import * as leave from '@/app/api/v1/t/[tenantSlug]/leave/route';
import * as leaveDecide from '@/app/api/v1/t/[tenantSlug]/leave/[id]/route';
import { at } from '../helpers/salon';

const typeId = async (c: any, slug: string, code: string) => (await c.call(types.GET, { params: { tenantSlug: slug } })).body.data.find((t: any) => t.code === code).id as string;

describe('annual leave balance', () => {
  it('accrues monthly from the hire date, is consumed by approved annual leave (not sick), blocks or warns, and can be adjusted by the owner', async () => {
    const s = await makeSalon();
    const p = { tenantSlug: s.slug };
    const hire = now().minus({ months: 13 }).toISODate()!;
    await setPay(s, s.staff.sara, 300000, hire);
    const sara = await member(s, 'specialist', s.staff.sara);

    const mine = (await sara.call(meHr.GET, { params: p })).body.data;
    expect(mine.balance).toMatchObject({ hire_date: hire, accrued: 22.75, taken: 0, balance: 22.75, yearly_entitlement: 21 });
    // Without a hire date there is no balance to enforce.
    expect((await s.owner.call(balances.GET, { params: p, query: { staff_id: s.staff.huda } })).body.data[0]).toMatchObject({ balance: null });

    const annual = await typeId(sara, s.slug, 'annual_leave');
    const sick = await typeId(sara, s.slug, 'sick_leave');
    // 30 working days is more than the balance: blocked.
    const tooMuch = await sara.call(requests.POST, { params: p, body: { type_id: annual, starts_on: dayOffset(20), ends_on: dayOffset(49) } });
    expect(tooMuch.status).toBe(422);
    expect(tooMuch.body.error).toMatchObject({ code: 'leave_balance_insufficient', details: { available: 22.75, requested: 30 } });

    const r = await sara.call(requests.POST, { params: p, body: { type_id: annual, starts_on: dayOffset(10), ends_on: dayOffset(12), note: 'سفر' } });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ status: 'pending', current_step: 0, leave_days: 3, warning: null });
    expect((await sara.call(meHr.GET, { params: p })).body.data.balance).toMatchObject({ pending: 3, balance: 22.75 });
    // The leave shows in the leave list as requested.
    const lv = (await s.owner.call(leave.GET, { params: p, query: { status: 'requested' } })).body.data;
    expect(lv.find((l: any) => l.id === r.body.data.leave_request_id)).toMatchObject({ leave_type: 'annual', staff_id: s.staff.sara });

    // The owner's approval is final at any step.
    const ok = await s.owner.call(decide.POST, { params: { ...p, id: r.body.data.id }, body: { decision: 'approved', note: 'موافقة' } });
    expect(ok.status).toBe(200);
    expect(ok.body.data.status).toBe('approved');
    const b1 = (await sara.call(meHr.GET, { params: p })).body.data.balance;
    expect(b1).toMatchObject({ taken: 3, pending: 0, balance: 19.75 });
    const leaveRow = await withTenant(s.tenantId, (trx) => trx.selectFrom('leave_requests').select(['status']).where('id', '=', r.body.data.leave_request_id).executeTakeFirstOrThrow());
    expect(leaveRow.status).toBe('approved');

    // Sick leave is tracked separately and does not consume annual balance.
    const sr = await sara.call(requests.POST, { params: p, body: { type_id: sick, starts_on: dayOffset(2), ends_on: dayOffset(3) } });
    expect(sr.status).toBe(201);
    await s.owner.call(decide.POST, { params: { ...p, id: sr.body.data.id }, body: { decision: 'approved' } });
    const b2 = (await sara.call(meHr.GET, { params: p })).body.data.balance;
    expect(b2).toMatchObject({ balance: 19.75 });
    expect(b2.sick_taken_year).toBe(2);

    // Owner adjustment (audited ledger); staff cannot adjust.
    expect((await sara.call(balanceOne.POST, { params: { ...p, staffId: s.staff.sara }, body: { days: 5, note: 'ترحيل' } })).status).toBe(403);
    expect((await s.owner.call(balanceOne.POST, { params: { ...p, staffId: s.staff.sara }, body: { days: 2.5 } })).status).toBe(422);
    const adj = await s.owner.call(balanceOne.POST, { params: { ...p, staffId: s.staff.sara }, body: { days: 2.25, note: 'رصيد مرحّل من النظام السابق' } });
    expect(adj.status).toBe(201);
    expect(adj.body.data.balance).toBe(22);
    const hist = (await sara.call(balanceOne.GET, { params: { ...p, staffId: s.staff.sara } })).body.data;
    expect(hist.map((h: any) => [h.bucket, h.kind, h.days])).toEqual(expect.arrayContaining([['annual', 'adjustment', 2.25], ['annual', 'taken', -3], ['sick', 'taken', -2]]));
    expect((await sara.call(balanceOne.GET, { params: { ...p, staffId: s.staff.huda } })).status).toBe(404);
    const audits = await withTenant(s.tenantId, (trx) => trx.selectFrom('audit_logs').select('action').where('action', '=', 'hr.leave_balance_adjusted').execute());
    expect(audits).toHaveLength(1);

    // Warn instead of block.
    expect((await sara.call(settings.PATCH, { method: 'PATCH', params: p, body: { leave_balance_policy: 'warn' } })).status).toBe(403);
    expect((await s.owner.call(settings.PATCH, { method: 'PATCH', params: p, body: { leave_balance_policy: 'warn', grace_minutes: 15 } })).body.data).toMatchObject({ leave_balance_policy: 'warn', grace_minutes: 15 });
    const warned = await sara.call(requests.POST, { params: p, body: { type_id: annual, starts_on: dayOffset(60), ends_on: dayOffset(89) } });
    expect(warned.status).toBe(201);
    expect(warned.body.data).toMatchObject({ balance_warning: true, warning: 'leave_balance_insufficient' });
  });
});

describe('approval chains', () => {
  it('moves step by step (manager → owner), keeps the full history, lets staff cancel while pending, and routes the original leave endpoints through the chain', async () => {
    const s = await makeSalon();
    const p = { tenantSlug: s.slug };
    await setPay(s, s.staff.sara, 300000, now().minus({ years: 2 }).toISODate()!);
    const sara = await member(s, 'specialist', s.staff.sara);
    const huda = await member(s, 'specialist', s.staff.huda);
    const manager = await member(s, 'manager');
    const emergency = await typeId(sara, s.slug, 'emergency_leave');

    const r = await sara.call(requests.POST, { params: p, body: { type_id: emergency, starts_on: dayOffset(4), ends_on: dayOffset(4), note: 'ظرف عائلي' } });
    expect(r.status).toBe(201);
    const id = r.body.data.id;
    const inbox = (await manager.call(requests.GET, { params: p, query: { scope: 'inbox' } })).body.data;
    expect(inbox.map((x: any) => x.id)).toContain(id);
    expect((await huda.call(decide.POST, { params: { ...p, id }, body: { decision: 'approved' } })).status).toBe(404);
    expect((await sara.call(decide.POST, { params: { ...p, id }, body: { decision: 'approved' } })).status).toBe(403);
    const step1 = await manager.call(decide.POST, { params: { ...p, id }, body: { decision: 'approved', note: 'لا مانع' } });
    expect(step1.body.data).toMatchObject({ status: 'pending', current_step: 1 });
    const again = await manager.call(decide.POST, { params: { ...p, id }, body: { decision: 'approved' } });
    expect(again.status).toBe(403);
    expect((await manager.call(requests.GET, { params: p, query: { scope: 'inbox' } })).body.data.map((x: any) => x.id)).not.toContain(id);
    const final = await s.owner.call(decide.POST, { params: { ...p, id }, body: { decision: 'approved' } });
    expect(final.body.data.status).toBe('approved');
    const detail = (await sara.call(requestOne.GET, { params: { ...p, id } })).body.data;
    expect(detail.actions.map((a: any) => [a.action, a.role, a.note])).toEqual([['submitted', null, 'ظرف عائلي'], ['approved', 'manager', 'لا مانع'], ['approved', 'owner', null]]);
    expect((await huda.call(requestOne.GET, { params: { ...p, id } })).status).toBe(404);
    // Emergency leave does not touch the annual balance.
    expect((await sara.call(meHr.GET, { params: p })).body.data.balance.taken).toBe(0);

    // Reject with a note; cancel while pending.
    const r2 = await sara.call(requests.POST, { params: p, body: { type_id: emergency, starts_on: dayOffset(7), ends_on: dayOffset(7) } });
    const rej = await manager.call(decide.POST, { params: { ...p, id: r2.body.data.id }, body: { decision: 'rejected', note: 'ضغط عمل' } });
    expect(rej.body.data.status).toBe('rejected');
    expect((await s.owner.call(decide.POST, { params: { ...p, id: r2.body.data.id }, body: { decision: 'approved' } })).body.error.code).toBe('already_decided');
    const r3 = await sara.call(requests.POST, { params: p, body: { type_id: emergency, starts_on: dayOffset(8), ends_on: dayOffset(8) } });
    expect((await huda.call(cancel.POST, { params: { ...p, id: r3.body.data.id }, body: {} })).status).toBe(404);
    expect((await sara.call(cancel.POST, { params: { ...p, id: r3.body.data.id }, body: { note: 'لم أعد بحاجة' } })).body.data.status).toBe('cancelled');
    expect((await sara.call(cancel.POST, { params: { ...p, id: r3.body.data.id }, body: {} })).body.error.code).toBe('request_not_pending');
    const lr3 = await withTenant(s.tenantId, (trx) => trx.selectFrom('leave_requests').select('status').where('id', '=', r3.body.data.leave_request_id).executeTakeFirstOrThrow());
    expect(lr3.status).toBe('cancelled');
    const mine = (await sara.call(requests.GET, { params: p, query: { scope: 'mine' } })).body.data;
    expect(mine.map((x: any) => x.status).sort()).toEqual(['approved', 'cancelled', 'rejected']);

    // Original leave endpoints: a manager's decision is one step, the owner's is final.
    const d = dayOffset(15);
    const legacy = await s.owner.call(leave.POST, { params: p, body: { staff_id: s.staff.huda, starts_at: at(d, '00:00'), ends_at: at(d, '23:59'), leave_type: 'annual' } });
    expect(legacy.status).toBe(201);
    expect(legacy.body.data.request_id).toBeTruthy();
    const m1 = await manager.call(leaveDecide.POST, { params: { ...p, id: legacy.body.data.id }, body: { decision: 'approved' } });
    expect(m1.body.data).toMatchObject({ status: 'requested', request_status: 'pending' });
    const o1 = await s.owner.call(leaveDecide.POST, { params: { ...p, id: legacy.body.data.id }, body: { decision: 'approved' } });
    expect(o1.body.data).toMatchObject({ status: 'approved' });
    // Types other than the chained ones keep the single-step approval.
    const personal = await s.owner.call(leave.POST, { params: p, body: { staff_id: s.staff.huda, starts_at: at(dayOffset(16), '00:00'), ends_at: at(dayOffset(16), '23:59'), leave_type: 'personal' } });
    expect(personal.body.data.request_id).toBeNull();
    expect((await manager.call(leaveDecide.POST, { params: { ...p, id: personal.body.data.id }, body: { decision: 'approved' } })).body.data.status).toBe('approved');
  });
});
