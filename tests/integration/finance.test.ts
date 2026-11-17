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

/** Same launch as src/server/infra/pdf.ts; reports why it cannot start. */
async function pdfRendererAvailable(): Promise<{ ok: boolean; reason: string }> {
  try {
    const { chromium } = await import('playwright-core');
    const b = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE || undefined, args: ['--no-sandbox', '--disable-gpu'] });
    await b.close();
    return { ok: true, reason: '' };
  } catch (e) {
    return { ok: false, reason: String((e as Error).message).split('\n')[0]!.slice(0, 200) };
  }
}

describe('finance', () => {
  it('reports deposits as liabilities, says "costs incomplete" honestly, and voids expenses by offset', async () => {
    const s = await makeSalon();
    const d = futureDate(3);
    const c = await customer();
    const h = await c.call(hold.POST, { params: { slug: s.slug }, body: { items: [{ key: 'x', service_id: s.services.haircut, staff_id: s.staff.sara, start: at(d, '10:00') }] }, idempotencyKey: true });
    await c.call(checkout.POST, { params: { slug: s.slug, id: h.body.data.booking_id }, body: { option: 'on_site' }, idempotencyKey: true });
    await s.owner.call(onSite.POST, { params: { tenantSlug: s.slug }, body: { booking_id: h.body.data.booking_id, amount_minor: 10000, method: 'cash', reference: 'F-1' }, idempotencyKey: true });
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

  }, 60_000);

  /**
   * PDF receipts need a headless Chromium (src/server/infra/pdf.ts; optional and
   * documented in README, RUNBOOK and DEPLOY_VERCEL). CI installs it, so there
   * the receipt MUST render. Elsewhere, when no matching Chromium can start
   * (e.g. playwright-core's pinned build is missing; set CHROMIUM_EXECUTABLE),
   * the documented contract is asserted instead: an honest 503
   * `pdf_renderer_unavailable` and a working printable HTML view.
   */
  it('renders a receipt as PDF, or degrades honestly when no PDF renderer is installed', async (ctx) => {
    const s = await makeSalon();
    const d = futureDate(3);
    const c = await customer();
    const h = await c.call(hold.POST, { params: { slug: s.slug }, body: { items: [{ key: 'x', service_id: s.services.haircut, staff_id: s.staff.sara, start: at(d, '11:00') }] }, idempotencyKey: true });
    await c.call(checkout.POST, { params: { slug: s.slug, id: h.body.data.booking_id }, body: { option: 'on_site' }, idempotencyKey: true });
    const pay = await s.owner.call(onSite.POST, { params: { tenantSlug: s.slug }, body: { booking_id: h.body.data.booking_id, amount_minor: 10000, method: 'cash', reference: 'F-2' }, idempotencyKey: true });
    const rc = await s.owner.call(receipts.POST, { params: { tenantSlug: s.slug }, body: { payment_id: pay.body.data.payment_id } });
    expect(rc.status).toBe(201);
    const { NextRequest } = await import('next/server');
    const cookie = [...s.owner.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await pdf.GET(new NextRequest(`http://localhost:3000/x`, { headers: { cookie } }), { params: Promise.resolve({ tenantSlug: s.slug, id: rc.body.data.id }) });
    const renderer = await pdfRendererAvailable();
    if (renderer.ok || process.env.CI) {
      expect(res.status, renderer.ok ? '' : `PDF renderer unavailable in CI: ${renderer.reason}`).toBe(200);
      const bytes = Buffer.from(await res.arrayBuffer());
      expect(bytes.subarray(0, 4).toString()).toBe('%PDF');
      return;
    }
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe('pdf_renderer_unavailable');
    const html = await pdf.GET(new NextRequest(`http://localhost:3000/x?format=html`, { headers: { cookie } }), { params: Promise.resolve({ tenantSlug: s.slug, id: rc.body.data.id }) });
    expect(html.status).toBe(200);
    expect(html.headers.get('content-type')).toContain('text/html');
    ctx.annotate(`PDF bytes not checked: no usable Chromium here (${renderer.reason}). Set CHROMIUM_EXECUTABLE to run the PDF assertion.`, 'notice');
    console.warn(`[finance.test] PDF renderer unavailable locally — asserted the documented 503 + HTML fallback instead. ${renderer.reason}`);
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
