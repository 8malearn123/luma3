import { describe, expect, it } from 'vitest';
import { makeSalon } from '../helpers/salon';
import { member, thisMonth } from '../helpers/hr';
import { withTenant } from '@/server/db/client';
import * as types from '@/app/api/v1/t/[tenantSlug]/hr/request-types/route';
import * as typeOne from '@/app/api/v1/t/[tenantSlug]/hr/request-types/[id]/route';
import * as requests from '@/app/api/v1/t/[tenantSlug]/hr/requests/route';
import * as decide from '@/app/api/v1/t/[tenantSlug]/hr/requests/[id]/decide/route';
import * as sheet from '@/app/api/v1/t/[tenantSlug]/payroll/sheet/route';

describe('request types and custom requests', () => {
  it('seeds the standard types, lets the owner configure chains and custom fields, and validates submissions', async () => {
    const s = await makeSalon();
    const p = { tenantSlug: s.slug };
    const sara = await member(s, 'specialist', s.staff.sara);
    const reception = await member(s, 'receptionist');
    const list = (await sara.call(types.GET, { params: p })).body.data;
    expect(list.map((t: any) => t.code)).toEqual(['annual_leave', 'sick_leave', 'emergency_leave', 'unpaid_leave', 'advance', 'salary_certificate', 'experience_letter']);
    expect(list.find((t: any) => t.code === 'annual_leave').approval_chain).toEqual(['manager', 'owner']);

    const body = {
      name_ar: 'طلب تدريب', name_en: 'Training request', kind: 'other', approval_chain: ['owner'],
      fields: [
        { key: 'course', label_ar: 'اسم الدورة', type: 'text', required: true },
        { key: 'cost', label_ar: 'التكلفة', type: 'number' },
        { key: 'mode', label_ar: 'النوع', type: 'select', options: ['حضوري', 'عن بعد'], required: true },
        { key: 'on', label_ar: 'التاريخ', type: 'date' },
      ],
    };
    expect((await sara.call(types.POST, { params: p, body })).status).toBe(403);
    expect((await s.owner.call(types.POST, { params: p, body: { ...body, fields: [{ key: 'x', label_ar: 'س', type: 'select', options: [] }] } })).status).toBe(422);
    expect((await s.owner.call(types.POST, { params: p, body: { ...body, approval_chain: ['specialist'] } })).status).toBe(422);
    const created = await s.owner.call(types.POST, { params: p, body });
    expect(created.status).toBe(201);
    const tid = created.body.data.id;
    expect(created.body.data.code).toMatch(/^custom_/);

    const submit = (values: Record<string, unknown>) => sara.call(requests.POST, { params: p, body: { type_id: tid, values } });
    expect((await submit({ mode: 'حضوري' })).body.error).toMatchObject({ code: 'request_field_required', details: { field: 'course' } });
    expect((await submit({ course: 'تلوين', mode: 'أخرى' })).body.error).toMatchObject({ code: 'request_field_invalid', details: { field: 'mode' } });
    expect((await submit({ course: 'تلوين', mode: 'حضوري', cost: 'abc' })).body.error.code).toBe('request_field_invalid');
    expect((await submit({ course: 'تلوين', mode: 'حضوري', on: '2026-13-40' })).body.error.code).toBe('request_field_invalid');
    const ok = await submit({ course: 'تلوين متقدم', mode: 'عن بعد', cost: '1500', on: '2026-12-01', ignored: 'x' });
    expect(ok.status).toBe(201);
    expect(ok.body.data.field_values).toEqual({ course: 'تلوين متقدم', mode: 'عن بعد', cost: 1500, on: '2026-12-01' });
    expect((await s.owner.call(decide.POST, { params: { ...p, id: ok.body.data.id }, body: { decision: 'approved' } })).body.data.status).toBe('approved');

    // A letter goes to the owner directly.
    const letter = list.find((t: any) => t.code === 'salary_certificate').id;
    const lr = await sara.call(requests.POST, { params: p, body: { type_id: letter, values: { addressed_to: 'البنك' } } });
    expect(lr.status).toBe(201);
    expect((await reception.call(decide.POST, { params: { ...p, id: lr.body.data.id }, body: { decision: 'approved' } })).status).toBe(404);

    // Reconfigure the chain; deactivate a type.
    expect((await reception.call(typeOne.PATCH, { method: 'PATCH', params: { ...p, id: tid }, body: { is_active: false } })).status).toBe(403);
    const upd = await s.owner.call(typeOne.PATCH, { method: 'PATCH', params: { ...p, id: tid }, body: { approval_chain: ['receptionist', 'owner'] } });
    expect(upd.body.data.approval_chain).toEqual(['receptionist', 'owner']);
    const r2 = await submit({ course: 'قص', mode: 'حضوري' });
    expect(r2.body.data.approval_chain).toEqual(['receptionist', 'owner']);
    expect((await reception.call(decide.POST, { params: { ...p, id: r2.body.data.id }, body: { decision: 'approved' } })).body.data).toMatchObject({ status: 'pending', current_step: 1 });
    await s.owner.call(typeOne.PATCH, { method: 'PATCH', params: { ...p, id: tid }, body: { is_active: false } });
    expect((await submit({ course: 'قص', mode: 'حضوري' })).status).toBe(404);
    expect((await sara.call(types.GET, { params: p })).body.data.some((t: any) => t.id === tid)).toBe(false);
    expect((await s.owner.call(types.GET, { params: p, query: { include_inactive: '1' } })).body.data.some((t: any) => t.id === tid)).toBe(true);
  });

  it('turns an approved advance request into a payroll advance with the instalments the approver set', async () => {
    const s = await makeSalon();
    const p = { tenantSlug: s.slug };
    const sara = await member(s, 'specialist', s.staff.sara);
    const advance = (await sara.call(types.GET, { params: p })).body.data.find((t: any) => t.code === 'advance').id;
    expect((await sara.call(requests.POST, { params: p, body: { type_id: advance } })).body.error.code).toBe('advance_amount_required');
    const r = await sara.call(requests.POST, { params: p, body: { type_id: advance, amount_minor: 90000, installments: 3, note: 'ظرف طارئ' } });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ amount_minor: 90000, installments: 3 });
    const ok = await s.owner.call(decide.POST, { params: { ...p, id: r.body.data.id }, body: { decision: 'approved', installments: 6, method: 'bank_transfer' } });
    expect(ok.status).toBe(200);
    expect(ok.body.data.payroll_entry_id).toBeTruthy();
    const e = await withTenant(s.tenantId, (trx) => trx.selectFrom('payroll_entries').selectAll().where('id', '=', ok.body.data.payroll_entry_id).executeTakeFirstOrThrow());
    expect(e).toMatchObject({ kind: 'advance', amount_minor: 90000, installments: 6, method: 'bank_transfer', staff_id: s.staff.sara });
    const row = (await s.owner.call(sheet.GET, { params: p, query: { month: thisMonth() } })).body.data.rows.find((x: any) => x.staff_id === s.staff.sara);
    expect(row.advance_minor).toBe(15000);
    const hist = await withTenant(s.tenantId, (trx) => trx.selectFrom('hr_request_actions').select(['action', 'data']).where('request_id', '=', r.body.data.id).orderBy('created_at').execute());
    expect(hist[1]).toMatchObject({ action: 'approved', data: { installments: { from: 3, to: 6 } } });
  });
});
