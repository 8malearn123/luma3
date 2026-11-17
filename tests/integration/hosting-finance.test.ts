import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { at, futureDate, makeSalon } from '../helpers/salon';
import { createBusinessFor, signup } from '../helpers/factory';
import { createProduct } from '../helpers/commerce';
import type { TestClient } from '../helpers/http';
import { withSystem, withTenant } from '@/server/db/client';
import { resolveSession, SESSION_COOKIE } from '@/server/auth/service';
import { resolveTenantAccess } from '@/server/tenancy/access';
import { financeReport, reportRows } from '@/server/domains/finance/service';
import * as resourceTypes from '@/app/api/v1/t/[tenantSlug]/resource-types/route';
import * as resources from '@/app/api/v1/t/[tenantSlug]/resources/route';
import * as services from '@/app/api/v1/t/[tenantSlug]/services/route';
import * as schedule from '@/app/api/v1/t/[tenantSlug]/staff/[id]/schedule/route';
import * as accounts from '@/app/api/v1/t/[tenantSlug]/payment-accounts/route';
import * as reauth from '@/app/api/v1/auth/reauth/route';
import * as sandboxPay from '@/app/api/v1/sandbox/checkout/[providerPaymentId]/route';
import * as sandboxRefund from '@/app/api/v1/sandbox/refunds/[providerRefundId]/route';
import * as listings from '@/app/api/v1/t/[tenantSlug]/hosting/listings/route';
import * as listingStatus from '@/app/api/v1/t/[tenantSlug]/hosting/listings/[id]/status/route';
import * as listingOptions from '@/app/api/v1/t/[tenantSlug]/hosting/listing-options/route';
import * as hostBooking from '@/app/api/v1/t/[tenantSlug]/hosting/bookings/[id]/route';
import * as hostMaterial from '@/app/api/v1/t/[tenantSlug]/hosting/bookings/[id]/materials/[requestId]/route';
import * as wsBookings from '@/app/api/v1/t/[tenantSlug]/workspace/bookings/route';
import * as wsBooking from '@/app/api/v1/t/[tenantSlug]/workspace/bookings/[id]/route';
import * as wsCheckout from '@/app/api/v1/t/[tenantSlug]/workspace/bookings/[id]/checkout/route';
import * as wsCancel from '@/app/api/v1/t/[tenantSlug]/workspace/bookings/[id]/cancel/route';
import * as wsMaterials from '@/app/api/v1/t/[tenantSlug]/workspace/bookings/[id]/materials/route';
import * as wsSummary from '@/app/api/v1/t/[tenantSlug]/workspace/summary/route';
import * as wsAppointments from '@/app/api/v1/t/[tenantSlug]/workspace/bookings/[id]/appointments/route';
import * as customersRoute from '@/app/api/v1/t/[tenantSlug]/customers/route';

/**
 * LUMA-AUDIT-010 / 037 / 013 — hosting money for both parties: the finance
 * report shows hosting revenue (salon) and hosting expense (expert), reconciled
 * to the journal and never counting the cash collection as a second revenue
 * event; the per-salon expense adds up to the total; the rent's tax share is
 * 15/115 of the rent; a full refund reverses the tax.
 */
const WEEK = Array.from({ length: 7 }, (_, d) => ({ weekday: d, start_time: '08:00', end_time: '22:00' }));
const iso = (s: string) => new Date(s).toISOString();
const accessOf = async (c: TestClient, slug: string) => resolveTenantAccess((await resolveSession(c.cookies.get(SESSION_COOKIE)))!, slug);
const today = () => DateTime.now().setZone('Asia/Riyadh');
const period = () => [today().minus({ days: 1 }).toISODate()!, today().plus({ days: 1 }).toISODate()!] as const;

async function journal(tenantId: string, account: string) {
  return withTenant(tenantId, async (trx) => {
    const r = await trx.selectFrom('financial_entries').select(['debit_minor', 'credit_minor']).where('account', '=', account as never).execute();
    return r.reduce((a, e) => a + Number(e.credit_minor) - Number(e.debit_minor), 0);
  });
}

async function host() {
  // The demo basis: 15% tax, prices INCLUDE tax (tenant_settings), as for the seeded salon.
  const s = await makeSalon({ settings: { tax_rate_bp: 1500, prices_include_tax: true } });
  const p = { tenantSlug: s.slug };
  const type = await s.owner.call(resourceTypes.POST, { params: p, body: { name_ar: 'كرسي' } });
  const chair = (await s.owner.call(resources.POST, { params: p, body: { branch_id: s.branchId, resource_type_id: type.body.data.id, name: 'Chair 1' } })).body.data.id as string;
  const dryer = (await s.owner.call(resources.POST, { params: p, body: { branch_id: s.branchId, resource_type_id: type.body.data.id, name: 'Dryer' } })).body.data.id as string;
  const prod = await createProduct(s.owner, s.slug, { name_ar: 'سيروم' }, { price_minor: 2000, initial_stock: 10 });
  // The listing editor's options (hosting scope): chairs, store products, payment readiness.
  const opts = await s.owner.call(listingOptions.GET, { params: p });
  expect(opts.status).toBe(200);
  expect(opts.body.data.payment_account_ready).toBe(true);
  expect(opts.body.data.resources.map((r: { id: string }) => r.id)).toEqual(expect.arrayContaining([chair, dryer]));
  expect(opts.body.data.products.some((v: { variant_id: string; price_minor: number }) => v.variant_id === prod.variants[0]!.id && v.price_minor === 2000)).toBe(true);
  const l = await s.owner.call(listings.POST, { params: p, body: {
    branch_id: s.branchId, resource_id: chair, code: 'C-1', price_model: 'fixed_hour', price_minor: 5000, booking_mode: 'instant', windows: WEEK, addons_discount_bp: 1000,
    cancellation_terms: { free_until_hours: 24, fee_bp: 5000 }, setup_buffer_min: 0, cleanup_buffer_min: 0,
    addons: [{ kind: 'product', product_variant_id: prod.variants[0]!.id, max_quantity: 5 }, { kind: 'equipment', resource_id: dryer, name_ar: 'مجفف', rental_price_minor: 1000, rental_unit: 'booking' }],
  } });
  expect(l.status, JSON.stringify(l.body)).toBe(201);
  const pub = await s.owner.call(listingStatus.POST, { params: { ...p, id: l.body.data.id }, body: { status: 'published', version: l.body.data.version } });
  expect(pub.status).toBe(200);
  const listed = (await s.owner.call(listingOptions.GET, { params: p })).body.data.resources.find((r: { id: string }) => r.id === chair);
  expect(listed.listing_id).toBe(l.body.data.id);
  return { ...s, listing: pub.body.data as { id: string; addons: Array<{ id: string; kind: string }> } };
}

async function expert() {
  const owner = await signup('Expert');
  const biz = await createBusinessFor(owner, { business_type: 'expert', plan_code: 'sanaa' });
  const p = { tenantSlug: biz.slug };
  const me = biz.staffProfileId!;
  await owner.call(schedule.PUT, { params: { ...p, id: me }, body: { branch_id: biz.branchId, ranges: Array.from({ length: 7 }, (_, d) => ({ weekday: d, start_time: '08:00', end_time: '23:00' })), breaks: [] } });
  const svc = await owner.call(services.POST, { params: p, body: { name_ar: 'مكياج', price_minor: 30000, duration_min: 60, buffer_before_min: 15, buffer_after_min: 15, staff: [{ staff_id: me }] } });
  expect(svc.status, JSON.stringify(svc.body)).toBe(201);
  await owner.call(reauth.POST, { body: { password: 'correct horse battery' } });
  await owner.call(accounts.POST, { params: p, body: { provider: 'sandbox' } });
  await withSystem('test: activate expert', async (trx) => {
    await trx.updateTable('tenants').set({ status: 'active' }).where('id', '=', biz.tenantId).execute();
    await trx.updateTable('tenant_settings').set({ min_notice_min: 0, slot_increment_min: 15, allow_pay_on_site: true }).where('tenant_id', '=', biz.tenantId).execute();
  });
  return { owner, slug: biz.slug, tenantId: biz.tenantId, me, service: svc.body.data.id as string };
}

async function bookAndPay(x: Awaited<ReturnType<typeof expert>>, listingId: string, start: string, addons: Array<{ addon_id: string; quantity: number }>) {
  const r = await x.owner.call(wsBookings.POST, { params: { tenantSlug: x.slug }, body: { listing_id: listingId, start: iso(start), duration_min: 120, addons }, idempotencyKey: true });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const co = await x.owner.call(wsCheckout.POST, { params: { tenantSlug: x.slug, id: r.body.data.id }, body: {}, idempotencyKey: true });
  expect(co.status, JSON.stringify(co.body)).toBe(201);
  const ref = co.body.data.payment.checkout_url.split('/sandbox/checkout/')[1].split('?')[0];
  expect((await x.owner.call(sandboxPay.POST, { params: { providerPaymentId: ref }, body: { outcome: 'captured' } })).body.data.webhook).toBe('processed');
  return (await x.owner.call(wsBooking.GET, { params: { tenantSlug: x.slug, id: r.body.data.id } })).body.data;
}

describe('hosting in the finance report, both parties (LUMA-AUDIT-010/037)', () => {
  it('reports hosting revenue and expense reconciled to the journal, without counting the collection twice', async () => {
    const h = await host();
    const x = await expert();
    const product = h.listing.addons.find((a) => a.kind === 'product')!;
    const d = futureDate(5);
    const w = await bookAndPay(x, h.listing.id, at(d, '10:00'), [{ addon_id: product.id, quantity: 1 }]);
    expect(w.status).toBe('confirmed');
    // 2 h × 50 = 100.00 rent + 20.00 serum − 10% add-ons discount (2.00) = 118.00, tax included.
    expect(w.total_minor).toBe(11800);

    // Salon: the rent's tax share is 10000 × 15/115 → 1304, so hosting revenue is 8696 (the audit saw 8713).
    const [from, to] = period();
    const hr = await financeReport(await accessOf(h.owner, h.slug), from, to);
    expect(hr.hosting_revenue.amount_minor).toBe(8696);
    expect(hr.hosting_revenue.amount_minor).toBe(await journal(h.tenantId, 'hosting_revenue'));
    expect(hr.hosting_revenue.discounts_minor).toBe(200);
    expect(hr.hosting_revenue.net_minor).toBe(8696 - 200);
    // Product add-on revenue is inside product sales (once) and shown for reference.
    expect(hr.hosting_revenue.product_addons_minor).toBe(await journal(h.tenantId, 'product_revenue'));
    expect(hr.product_sales.amount_minor).toBe(hr.hosting_revenue.product_addons_minor);
    // Revenue + tax − discount = the money collected; the collection is cash, not a second revenue line.
    expect(hr.collections.total_minor).toBe(11800);
    expect(hr.hosting_revenue.amount_minor + hr.hosting_revenue.product_addons_minor + hr.tax.collected_minor - hr.hosting_revenue.discounts_minor).toBe(hr.collections.total_minor);
    if (hr.profit.status === 'computed') expect(hr.profit.amount_minor).toBe(hr.hosting_revenue.net_minor + hr.product_sales.amount_minor - hr.product_costs.amount_minor! - hr.expenses.total_minor);
    const rows = await reportRows(await accessOf(h.owner, h.slug), from, to);
    expect(rows.find((r) => r.line === 'hosting_revenue')).toMatchObject({ amount_minor: 8696 });
    expect(rows.find((r) => r.line === 'hosting_revenue')!.basis).toMatch(/accrual/);

    // Statement: salon net = total charges (no platform fee), not just what was collected.
    const hb = (await h.owner.call(hostBooking.GET, { params: { tenantSlug: h.slug, id: w.id } })).body.data;
    expect(hb.statement.host_net_minor).toBe(hb.statement.total_charges_minor);

    // Expert: hosting expense = what she owes/paid, from her journal.
    const xr = await financeReport(await accessOf(x.owner, x.slug), from, to);
    expect(xr.hosting_expense.amount_minor).toBe(11800);
    expect(xr.hosting_expense.amount_minor).toBe(-(await journal(x.tenantId, 'hosting_expense')));
    expect(xr.hosting_revenue.amount_minor).toBe(0);
    expect(xr.collections.total_minor).toBe(0);
    if (xr.profit.status === 'computed') expect(xr.profit.amount_minor).toBeLessThanOrEqual(-11800);

    // An approved material request after payment is an unpaid due: the expense total and the per-salon
    // figure both include it (the per-salon list used to show paid − refunded only).
    const mr = await x.owner.call(wsMaterials.POST, { params: { tenantSlug: x.slug, id: w.id }, body: { addon_id: product.id, quantity: 1 } });
    expect([200, 201], JSON.stringify(mr.body)).toContain(mr.status);
    const reqId = (await h.owner.call(hostBooking.GET, { params: { tenantSlug: h.slug, id: w.id } })).body.data.material_requests[0].id;
    const ok = await h.owner.call(hostMaterial.POST, { params: { tenantSlug: h.slug, id: w.id, requestId: reqId }, body: { approve: true } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const sum = (await x.owner.call(wsSummary.GET, { params: { tenantSlug: x.slug } })).body.data;
    expect(sum.dues_minor).toBeGreaterThan(0);
    expect(sum.hosting_expense_minor).toBe(11800 + sum.dues_minor);
    expect(sum.per_host.reduce((a: number, p: { total_minor: number }) => a + p.total_minor, 0)).toBe(sum.hosting_expense_minor);
    expect(sum.unmapped_minor).toBe(0);
    const xr2 = await financeReport(await accessOf(x.owner, x.slug), from, to);
    expect(xr2.hosting_expense).toMatchObject({ amount_minor: sum.hosting_expense_minor, dues_minor: sum.dues_minor });
  });

  it('a full refund reverses the tax at the frozen rate and the expense nets to zero', async () => {
    const h = await host();
    const x = await expert();
    const taxBefore = await journal(h.tenantId, 'tax_payable');
    const w = await bookAndPay(x, h.listing.id, at(futureDate(10), '10:00'), []);
    expect(await journal(h.tenantId, 'tax_payable') - taxBefore).toBe(1304);
    const c = await x.owner.call(wsCancel.POST, { params: { tenantSlug: x.slug, id: w.id }, body: { reason: 'change of plans' } });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    const refunds = await withTenant(h.tenantId, (trx) => trx.selectFrom('refunds as r').innerJoin('payments as p', 'p.id', 'r.payment_id').select(['r.amount_minor', 'r.provider_refund_id']).where('p.workspace_booking_id', '=', w.id).execute());
    expect(refunds).toHaveLength(1);
    expect(refunds[0]!.amount_minor).toBe(10000);
    await x.owner.call(sandboxRefund.POST, { params: { providerRefundId: refunds[0]!.provider_refund_id! }, body: { outcome: 'succeeded' } });
    expect(await journal(h.tenantId, 'tax_payable')).toBe(taxBefore);
    const [from, to] = period();
    const hr = await financeReport(await accessOf(h.owner, h.slug), from, to);
    expect(hr.hosting_revenue).toMatchObject({ amount_minor: 8696, refunds_minor: 8696, net_minor: 0 });
    const xr = await financeReport(await accessOf(x.owner, x.slug), from, to);
    expect(xr.hosting_expense.amount_minor).toBe(0);
    const sum = (await x.owner.call(wsSummary.GET, { params: { tenantSlug: x.slug } })).body.data;
    expect(sum.hosting_expense_minor).toBe(0);
    expect(sum.per_host.reduce((a: number, p: { total_minor: number }) => a + p.total_minor, 0)).toBe(0);
  });
});

describe('client appointment inside a confirmed space (requirement 13, LUMA-AUDIT-013)', () => {
  it('confirms an appointment that fits with its buffers, refuses one whose buffers spill out, and the host sees nothing of it', async () => {
    const h = await host();
    const x = await expert();
    const d = futureDate(6);
    const w = await bookAndPay(x, h.listing.id, at(d, '12:00'), []);
    expect(w.can.add_appointment).toBe(true);
    expect(w.guest_staff_id).toBe(x.me);
    const cust = await x.owner.call(customersRoute.POST, { params: { tenantSlug: x.slug }, body: { display_name: 'عروس', phone: '+966511112222', source: 'walk_in' } });
    expect(cust.status, JSON.stringify(cust.body)).toBe(201);
    const body = (hhmm: string) => ({ customer_id: cust.body.data.id, mode: 'confirm_on_site', items: [{ key: 'a', service_id: x.service, staff_id: x.me, start: iso(at(d, hhmm)) }] });
    // 12:00 start: the 15-min preparation would begin at 11:45, before the space (12:00–14:00).
    const early = await x.owner.call(wsAppointments.POST, { params: { tenantSlug: x.slug, id: w.id }, body: body('12:00'), idempotencyKey: true });
    expect(early.status).toBe(422);
    expect(early.body.error.code).toBe('outside_workspace_window');
    const ok = await x.owner.call(wsAppointments.POST, { params: { tenantSlug: x.slug, id: w.id }, body: body('12:15'), idempotencyKey: true });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.data.confirmed).toBe(true);
    const g = (await x.owner.call(wsBooking.GET, { params: { tenantSlug: x.slug, id: w.id } })).body.data;
    expect(g.linked_appointments).toHaveLength(1);
    expect(g.linked_appointments[0].status).toBe('confirmed');
    // D14: the host's view of the space booking carries nothing about the client.
    const hv = JSON.stringify((await h.owner.call(hostBooking.GET, { params: { tenantSlug: h.slug, id: w.id } })).body.data);
    expect(hv).not.toContain('عروس');
    expect(hv).not.toContain(ok.body.data.booking_id);
  });
});
