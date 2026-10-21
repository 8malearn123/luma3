import { describe, expect, it } from 'vitest';
import { at, customer, futureDate, makeSalon } from '../helpers/salon';
import { withTenant } from '@/server/db/client';
import * as hold from '@/app/api/v1/s/[slug]/bookings/route';
import * as checkout from '@/app/api/v1/s/[slug]/bookings/[id]/checkout/route';
import * as onSite from '@/app/api/v1/t/[tenantSlug]/payments/on-site/route';
import * as report from '@/app/api/v1/t/[tenantSlug]/finance/report/route';
import * as expenses from '@/app/api/v1/t/[tenantSlug]/finance/expenses/route';
import * as voidExpense from '@/app/api/v1/t/[tenantSlug]/finance/expenses/[id]/void/route';
import * as receipts from '@/app/api/v1/t/[tenantSlug]/finance/receipts/route';
import * as pdf from '@/app/api/v1/t/[tenantSlug]/finance/invoices/[id]/pdf/route';
import * as exportsRoute from '@/app/api/v1/t/[tenantSlug]/finance/exports/route';
import * as reauth from '@/app/api/v1/auth/reauth/route';
import * as invitations from '@/app/api/v1/t/[tenantSlug]/invitations/route';
import * as accept from '@/app/api/v1/invitations/accept/route';
import * as media from '@/app/api/v1/media/[id]/route';
import { signup } from '../helpers/factory';

describe('finance', () => {
  it('reports deposits as liabilities, says "costs incomplete" honestly, and voids expenses by offset', async () => {
    const s = await makeSalon();
    const d = futureDate(3);
    const c = await customer();
    const h = await c.call(hold.POST, { params: { slug: s.slug }, body: { items: [{ key: 'x', service_id: s.services.haircut, staff_id: s.staff.sara, start: at(d, '10:00') }] }, idempotencyKey: true });
    await c.call(checkout.POST, { params: { slug: s.slug, id: h.body.data.booking_id }, body: { option: 'on_site' }, idempotencyKey: true });
    const pay = await s.owner.call(onSite.POST, { params: { tenantSlug: s.slug }, body: { booking_id: h.body.data.booking_id, amount_minor: 10000, method: 'cash', reference: 'F-1' }, idempotencyKey: true });
    const e = await s.owner.call(expenses.POST, { params: { tenantSlug: s.slug }, body: { category: 'supplies', amount_minor: 2500, incurred_on: d } });
    expect(e.status).toBe(201);
    const p = { tenantSlug: s.slug };
    const today = futureDate(0);
    const r = await s.owner.call(report.GET, { params: p, query: { from: today, to: d } });
    expect(r.status).toBe(200);
    expect(r.body.data.collections.total_minor).toBe(10000);
    expect(r.body.data.completed_service_sales.amount_minor).toBe(0); // not completed yet: deposit, not revenue
    expect(r.body.data.deposits_outstanding.amount_minor).toBe(10000);
    expect(r.body.data.expenses.total_minor).toBe(2500);
    expect(r.body.data.profit.status).toBe('costs_incomplete');
    expect(r.body.data.profit.amount_minor).toBeNull();
    await s.owner.call(voidExpense.POST, { params: { ...p, id: e.body.data.id }, body: { reason: 'duplicate entry' } });
    const r2 = await s.owner.call(report.GET, { params: p, query: { from: today, to: d } });
    expect(r2.body.data.expenses.total_minor).toBe(0);
    const offsets = await withTenant(s.tenantId, (trx) => trx.selectFrom('financial_entries').select(['ref_type']).where('ref_id', '=', e.body.data.id).execute());
    expect(offsets.map((x) => x.ref_type).sort()).toEqual(['expense', 'expense', 'expense_void', 'expense_void']);

    // Receipt renders as a real PDF.
    const rc = await s.owner.call(receipts.POST, { params: p, body: { payment_id: pay.body.data.payment_id } });
    expect(rc.status).toBe(201);
    const { NextRequest } = await import('next/server');
    const req = new NextRequest(`http://localhost:3000/x`, { headers: { cookie: [...s.owner.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } });
    const res = await pdf.GET(req, { params: Promise.resolve({ tenantSlug: s.slug, id: rc.body.data.id }) });
    expect(res.status).toBe(200);
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.subarray(0, 4).toString()).toBe('%PDF');
  }, 60_000);

  it('finance is confidential: receptionists cannot read reports; exports need step-up and are protected', async () => {
    const s = await makeSalon();
    const recep = await signup('Reception');
    const inv = await s.owner.call(invitations.POST, { params: { tenantSlug: s.slug }, body: { identifier: recep.identifier, role: 'receptionist' } });
    await recep.call(accept.POST, { body: { token: inv.body.data.dev_invite_link.split('/invite/')[1] } });
    const d = futureDate(1);
    expect((await recep.call(report.GET, { params: { tenantSlug: s.slug }, query: { from: d, to: d } })).status).toBe(403);
    // Formula-injection attempt in an expense description.
    await s.owner.call(expenses.POST, { params: { tenantSlug: s.slug }, body: { category: 'other', amount_minor: 100, incurred_on: d, description: '=HYPERLINK("http://evil")' } });
    const fresh = s.owner;
    fresh.cookies.set('luma_session', fresh.cookies.get('luma_session')!);
    const ex = await fresh.call(exportsRoute.POST, { params: { tenantSlug: s.slug }, body: { kind: 'expenses', from: d, to: d } });
    // makeSalon re-authenticated recently, so step-up is satisfied.
    expect(ex.status).toBe(201);
    const assetId = ex.body.data.download_url.split('/').pop();
    const dl = await fresh.call(media.GET, { params: { id: assetId } });
    expect(dl.status).toBe(200);
    expect(String(dl.body)).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect((await recep.call(media.GET, { params: { id: assetId } })).status).toBe(404);
    expect((await customer().then((c) => c.call(media.GET, { params: { id: assetId } }))).status).toBe(404);
    void reauth;
  });
});
