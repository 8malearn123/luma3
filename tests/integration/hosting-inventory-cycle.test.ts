/**
 * Cross-module end-to-end cycles: purchasing → multi-location stock → service
 * consumption → finance (scenario A) and the freelancer workspace journey with a
 * product add-on sold from salon stock (scenario B). Real route handlers via
 * TestClient; the domain functions are called directly only where the clock
 * must be moved (check-in on the appointment day).
 */
import { describe, expect, it } from 'vitest';
import { at, customer, futureDate, makeSalon } from '../helpers/salon';
import { createBusinessFor, signup, uniq } from '../helpers/factory';
import { createProduct } from '../helpers/commerce';
import type { TestClient } from '../helpers/http';
import { withSystem, withTenant } from '@/server/db/client';
import { resolveSession, SESSION_COOKIE } from '@/server/auth/service';
import { resolveTenantAccess } from '@/server/tenancy/access';
import { transition } from '@/server/domains/booking/service';
import { guestCheck } from '@/server/domains/hosting/bookings';
import { hostingTx, lockBooking } from '@/server/domains/hosting/scope';
import { findStockMismatches } from '@/server/domains/commerce/integrity';
import * as items from '@/app/api/v1/t/[tenantSlug]/inventory/items/route';
import * as itemOne from '@/app/api/v1/t/[tenantSlug]/inventory/items/[id]/route';
import * as itemMoves from '@/app/api/v1/t/[tenantSlug]/inventory/items/[id]/movements/route';
import * as locations from '@/app/api/v1/t/[tenantSlug]/inventory/locations/route';
import * as balances from '@/app/api/v1/t/[tenantSlug]/inventory/balances/route';
import * as transfers from '@/app/api/v1/t/[tenantSlug]/inventory/transfers/route';
import * as consumptions from '@/app/api/v1/t/[tenantSlug]/inventory/consumptions/route';
import * as reports from '@/app/api/v1/t/[tenantSlug]/inventory/reports/[kind]/route';
import * as recipe from '@/app/api/v1/t/[tenantSlug]/inventory/recipes/[serviceId]/route';
import * as suppliers from '@/app/api/v1/t/[tenantSlug]/purchasing/suppliers/route';
import * as receipts from '@/app/api/v1/t/[tenantSlug]/purchasing/receipts/route';
import * as invoices from '@/app/api/v1/t/[tenantSlug]/purchasing/invoices/route';
import * as invoicePost from '@/app/api/v1/t/[tenantSlug]/purchasing/invoices/[id]/post/route';
import * as payments from '@/app/api/v1/t/[tenantSlug]/purchasing/payments/route';
import * as financeReport from '@/app/api/v1/t/[tenantSlug]/finance/report/route';
import * as services from '@/app/api/v1/t/[tenantSlug]/services/route';
import * as resourceTypes from '@/app/api/v1/t/[tenantSlug]/resource-types/route';
import * as resources from '@/app/api/v1/t/[tenantSlug]/resources/route';
import * as schedule from '@/app/api/v1/t/[tenantSlug]/staff/[id]/schedule/route';
import * as accounts from '@/app/api/v1/t/[tenantSlug]/payment-accounts/route';
import * as reauth from '@/app/api/v1/auth/reauth/route';
import * as hold from '@/app/api/v1/s/[slug]/bookings/route';
import * as holdCheckout from '@/app/api/v1/s/[slug]/bookings/[id]/checkout/route';
import * as tTransition from '@/app/api/v1/t/[tenantSlug]/bookings/[id]/transition/route';
import * as sandboxPay from '@/app/api/v1/sandbox/checkout/[providerPaymentId]/route';
import * as links from '@/app/api/v1/t/[tenantSlug]/hosting/links/route';
import * as listings from '@/app/api/v1/t/[tenantSlug]/hosting/listings/route';
import * as listingStatus from '@/app/api/v1/t/[tenantSlug]/hosting/listings/[id]/status/route';
import * as hostBookings from '@/app/api/v1/t/[tenantSlug]/hosting/bookings/route';
import * as hostBooking from '@/app/api/v1/t/[tenantSlug]/hosting/bookings/[id]/route';
import * as hostSettlement from '@/app/api/v1/t/[tenantSlug]/hosting/bookings/[id]/settlement/route';
import * as hostSummary from '@/app/api/v1/t/[tenantSlug]/hosting/summary/route';
import * as search from '@/app/api/v1/t/[tenantSlug]/workspace/search/route';
import * as wsListing from '@/app/api/v1/t/[tenantSlug]/workspace/listings/[id]/route';
import * as wsQuote from '@/app/api/v1/t/[tenantSlug]/workspace/quote/route';
import * as wsBookings from '@/app/api/v1/t/[tenantSlug]/workspace/bookings/route';
import * as wsBooking from '@/app/api/v1/t/[tenantSlug]/workspace/bookings/[id]/route';
import * as wsCheckout from '@/app/api/v1/t/[tenantSlug]/workspace/bookings/[id]/checkout/route';
import * as wsInvoice from '@/app/api/v1/t/[tenantSlug]/workspace/bookings/[id]/invoices/[invoiceId]/route';
import * as wsAppointments from '@/app/api/v1/t/[tenantSlug]/workspace/bookings/[id]/appointments/route';
import * as wsSummary from '@/app/api/v1/t/[tenantSlug]/workspace/summary/route';

// ── Shared helpers ──────────────────────────────────────────────────────────
const iso = (s: string) => new Date(s).toISOString();
const today = () => new Date().toISOString().slice(0, 10);

async function accessOf(c: TestClient, slug: string) {
  const user = (await resolveSession(c.cookies.get(SESSION_COOKIE)))!;
  return { user, access: await resolveTenantAccess(user, slug) };
}

type Entry = { entry_group_id: string; account: string; debit_minor: number; credit_minor: number; ref_type: string; ref_id: string };
const entries = (tenantId: string) => withTenant(tenantId, (trx) =>
  trx.selectFrom('financial_entries').select(['entry_group_id', 'account', 'debit_minor', 'credit_minor', 'ref_type', 'ref_id']).execute()) as Promise<Entry[]>;

/** Every journal group of the tenant sums to zero (debits = credits). */
function unbalancedGroups(rows: Entry[]) {
  const g = new Map<string, number>();
  for (const r of rows) g.set(r.entry_group_id, (g.get(r.entry_group_id) ?? 0) + r.debit_minor - r.credit_minor);
  return [...g.entries()].filter(([, v]) => v !== 0);
}
const net = (rows: Entry[], account: string) => rows.filter((r) => r.account === account).reduce((a, r) => a + r.debit_minor - r.credit_minor, 0);

async function chairResource(owner: TestClient, slug: string, branchId: string, name: string) {
  const type = await owner.call(resourceTypes.POST, { params: { tenantSlug: slug }, body: { name_ar: 'كرسي', name_en: 'Chair' } });
  expect(type.status).toBe(201);
  const r = await owner.call(resources.POST, { params: { tenantSlug: slug }, body: { branch_id: branchId, resource_type_id: type.body.data.id, name } });
  expect(r.status).toBe(201);
  return r.body.data.id as string;
}

// ── Scenario A ──────────────────────────────────────────────────────────────
describe('salon material cycle: purchase → transfer → service consumption → finance', () => {
  it('weighted average, station transfer, one consumption at the frozen cost, invoice/payment and a reconciled ledger', async () => {
    const s = await makeSalon({ plan: 'fareed' });
    const p = { tenantSlug: s.slug };
    const main = ((await s.owner.call(locations.GET, { params: p })).body.data as any[]).find((l) => l.is_default)!.id as string;

    // Material card (one bottle = one piece) and a supplier.
    const it0 = await s.owner.call(items.POST, { params: p, body: { name: 'Developer 6%', unit: 'piece' } });
    expect(it0.status, JSON.stringify(it0.body)).toBe(201);
    const dev = it0.body.data.id as string;
    const sup = await s.owner.call(suppliers.POST, { params: p, body: { name: 'مورد الصبغات' } });
    expect(sup.status).toBe(201);

    // Two goods receipts into the main warehouse at different costs: 20 × 10.00, then 10 × 16.00.
    const receive = async (quantity: number, cost: number, day: string) => {
      const r = await s.owner.call(receipts.POST, { params: p, idempotencyKey: true, body: {
        supplier_id: sup.body.data.id, location_id: main, received_on: day, post: true, lines: [{ inventory_item_id: dev, quantity, unit_cost_minor: cost }],
      } });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      return r.body.data;
    };
    const rc1 = await receive(20, 1000, '2026-11-01');
    let card = (await s.owner.call(itemOne.GET, { params: { ...p, id: dev } })).body.data;
    expect(card).toMatchObject({ on_hand: 20, avg_cost_minor: 1000, stock_value_minor: 20000 });
    const rc2 = await receive(10, 1600, '2026-11-02');
    card = (await s.owner.call(itemOne.GET, { params: { ...p, id: dev } })).body.data;
    // (20 × 1000 + 10 × 1600) / 30 = 1200
    expect(card).toMatchObject({ on_hand: 30, avg_cost_minor: 1200, stock_value_minor: 36000 });

    // A chair-station location serving chair 3; transfer 2 bottles from the main warehouse.
    const chair = await chairResource(s.owner, s.slug, s.branchId, 'Chair 3');
    const st = await s.owner.call(locations.POST, { params: p, body: { kind: 'station', name: 'محطة كرسي 3', resource_ids: [chair] } });
    expect(st.status, JSON.stringify(st.body)).toBe(201);
    const station = st.body.data.id as string;
    const trf = await s.owner.call(transfers.POST, { params: p, idempotencyKey: true, body: { from_location_id: main, to_location_id: station, lines: [{ inventory_item_id: dev, quantity: 2 }] } });
    expect(trf.status, JSON.stringify(trf.body)).toBe(201);
    expect(trf.body.data.lines[0]).toMatchObject({ quantity: 2, unit_cost_minor: 1200, total_cost_minor: 2400 });
    const bal = async () => Object.fromEntries(((await s.owner.call(balances.GET, { params: p, query: { inventory_item_id: dev } })).body.data.items as any[]).map((b) => [b.location_id, Number(b.on_hand)]));
    let b = await bal();
    expect(b[main]).toBe(28);
    expect(b[station]).toBe(2);
    expect((await s.owner.call(itemOne.GET, { params: { ...p, id: dev } })).body.data.on_hand).toBe(30);
    const trfMoves = await withTenant(s.tenantId, (trx) => trx.selectFrom('stock_movements').select('id').where('document_id', '=', trf.body.data.id).execute());
    expect(trfMoves).toHaveLength(2);
    expect((await entries(s.tenantId)).filter((e) => trfMoves.some((m) => m.id === e.ref_id))).toEqual([]);
    expect((await entries(s.tenantId)).some((e) => e.ref_type === 'stock_transfer')).toBe(false);

    // A colour service using one bottle; Sara works on chair 3.
    const svc = await s.owner.call(services.POST, { params: p, body: { name_ar: 'صبغة جذور', price_minor: 20000, duration_min: 60, staff: [{ staff_id: s.staff.sara }] } });
    expect(svc.status).toBe(201);
    const serviceId = svc.body.data.id as string;
    expect((await s.owner.call(recipe.PUT, { params: { ...p, serviceId }, body: { lines: [{ inventory_item_id: dev, quantity: 1, unit: 'piece' }] } })).status).toBe(200);
    expect((await s.owner.call(links.PUT, { params: p, body: { resource_id: chair, staff_ids: [s.staff.sara] } })).status).toBe(200);

    // A client books Sara; the engine reserves chair 3 with her.
    const d = futureDate(4);
    const c = await customer('Client A');
    const h = await c.call(hold.POST, { params: { slug: s.slug }, idempotencyKey: true, body: { items: [{ key: 'a', service_id: serviceId, staff_id: s.staff.sara, start: iso(at(d, '11:00')) }] } });
    expect(h.status, JSON.stringify(h.body)).toBe(201);
    const bookingId = h.body.data.booking_id as string;
    const co = await c.call(holdCheckout.POST, { params: { slug: s.slug, id: bookingId }, body: { option: 'on_site' }, idempotencyKey: true });
    expect(co.body.data.status).toBe('confirmed');
    const alloc = await withTenant(s.tenantId, (trx) => trx.selectFrom('booking_allocations').select('resource_id').where('booking_id', '=', bookingId).where('resource_id', 'is not', null).execute());
    expect(alloc.map((a) => a.resource_id)).toEqual([chair]);

    // Check-in on the appointment day (clock moved), then complete through the route.
    const { user, access } = await accessOf(s.owner, s.slug);
    const bk = await withTenant(s.tenantId, (trx) => trx.selectFrom('bookings').select('starts_at').where('id', '=', bookingId).executeTakeFirstOrThrow());
    await transition(s.tenantId, bookingId, 'check_in', { kind: 'staff', access, audit: { userId: user.userId, kind: 'user' } }, { now: new Date(bk.starts_at.getTime() + 5 * 60_000) });
    const done = await s.owner.call(tTransition.POST, { params: { ...p, id: bookingId }, body: { action: 'complete' } });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    // Completing twice is refused and cannot consume again.
    expect((await s.owner.call(tTransition.POST, { params: { ...p, id: bookingId }, body: { action: 'complete' } })).status).not.toBe(200);

    // Consumption: exactly once, from the station, at the frozen average cost.
    const bi = await withTenant(s.tenantId, (trx) => trx.selectFrom('booking_items').select('id').where('booking_id', '=', bookingId).executeTakeFirstOrThrow());
    const cons = (await s.owner.call(consumptions.GET, { params: p, query: { booking_item_id: bi.id } })).body.data as any[];
    expect(cons).toHaveLength(1);
    expect(cons[0]).toMatchObject({ location_id: station, expected_qty: 1, actual_qty: 1, posted_qty: 1, status: 'posted', total_cost_minor: 1200 });
    const consMoves = await withTenant(s.tenantId, (trx) => trx.selectFrom('stock_movements').select(['id', 'location_id', 'quantity', 'unit_cost_minor', 'total_cost_minor'])
      .where('inventory_item_id', '=', dev).where('kind', '=', 'consumption').execute());
    expect(consMoves).toHaveLength(1);
    expect({ ...consMoves[0], quantity: Number(consMoves[0]!.quantity), unit_cost_minor: Number(consMoves[0]!.unit_cost_minor), total_cost_minor: Number(consMoves[0]!.total_cost_minor) })
      .toMatchObject({ location_id: station, quantity: -1, unit_cost_minor: 1200, total_cost_minor: -1200 });
    const consJ = (await entries(s.tenantId)).filter((e) => e.ref_id === consMoves[0]!.id).map((e) => [e.account, e.debit_minor, e.credit_minor]).sort();
    expect(consJ).toEqual([['inventory', 0, 1200], ['material_costs', 1200, 0]]);
    b = await bal();
    expect(b[station]).toBe(1);
    expect(b[main]).toBe(28);

    // Finance report: material cost = the frozen movement cost, unchanged by a later cost edit.
    const fr = async () => (await s.owner.call(financeReport.GET, { params: p, query: { from: today(), to: today() } })).body.data;
    expect((await fr()).material_costs).toMatchObject({ amount_minor: 1200, complete: true });
    expect((await s.owner.call(itemOne.PATCH, { params: { ...p, id: dev }, body: { cost_per_unit_minor: 9999 } })).status).toBe(200);
    expect((await fr()).material_costs.amount_minor).toBe(1200);

    // Supplier invoice matched to both receipts: no stock added.
    const inv = await s.owner.call(invoices.POST, { params: p, body: {
      supplier_id: sup.body.data.id, invoice_number: `INV-${uniq()}`, invoice_date: '2026-11-03', lines: [
        { inventory_item_id: dev, quantity: 20, unit_cost_minor: 1000, tax_minor: 3000, links: [{ receipt_line_id: rc1.lines[0].id, quantity: 20 }] },
        { inventory_item_id: dev, quantity: 10, unit_cost_minor: 1600, tax_minor: 2400, links: [{ receipt_line_id: rc2.lines[0].id, quantity: 10 }] },
      ],
    } });
    expect(inv.status, JSON.stringify(inv.body)).toBe(201);
    expect(inv.body.data).toMatchObject({ total_minor: 41400, matching: 'matched' });
    const posted = await s.owner.call(invoicePost.POST, { params: { ...p, id: inv.body.data.id }, body: {} });
    expect(posted.body.data).toMatchObject({ status: 'posted', outstanding_minor: 41400 });
    expect((await s.owner.call(itemOne.GET, { params: { ...p, id: dev } })).body.data).toMatchObject({ on_hand: 29, avg_cost_minor: 1200 });
    let je = await entries(s.tenantId);
    expect(net(je, 'accounts_payable')).toBe(-41400);
    expect(net(je, 'goods_received_not_invoiced')).toBe(0);

    // Supplier payment clears accounts payable.
    const pay = await s.owner.call(payments.POST, { params: p, idempotencyKey: true, body: { supplier_id: sup.body.data.id, invoice_id: inv.body.data.id, amount_minor: 41400, method: 'bank', paid_on: '2026-11-05' } });
    expect(pay.status, JSON.stringify(pay.body)).toBe(201);
    je = await entries(s.tenantId);
    expect(net(je, 'accounts_payable')).toBe(0);
    expect(net(je, 'input_tax')).toBe(5400);

    // Every journal group is balanced; the inventory account equals the valuation report.
    expect(unbalancedGroups(je)).toEqual([]);
    const val = (await s.owner.call(reports.GET, { params: { ...p, kind: 'valuation' } })).body.data;
    expect(val).toMatchObject({ inventory_value_minor: 29 * 1200, ledger_inventory_minor: 29 * 1200, difference_minor: 0, accounts_payable_minor: 0, received_not_invoiced_minor: 0 });
    expect(net(je, 'inventory')).toBe(val.inventory_value_minor);
    expect(await findStockMismatches(s.tenantId)).toEqual([]);
  });
});

// ── Scenario B ──────────────────────────────────────────────────────────────
async function makeExpert() {
  const owner = await signup('Lamar Expert');
  const biz = await createBusinessFor(owner, { business_type: 'expert', plan_code: 'sanaa' });
  const p = { tenantSlug: biz.slug };
  const me = biz.staffProfileId!;
  await owner.call(schedule.PUT, { params: { ...p, id: me }, body: { branch_id: biz.branchId, ranges: Array.from({ length: 7 }, (_, d) => ({ weekday: d, start_time: '08:00', end_time: '23:00' })), breaks: [] } });
  const svc = await owner.call(services.POST, { params: p, body: { name_ar: 'مكياج عروس', price_minor: 50000, duration_min: 60, staff: [{ staff_id: me }] } });
  await owner.call(reauth.POST, { body: { password: 'correct horse battery' } });
  await owner.call(accounts.POST, { params: p, body: { provider: 'sandbox' } });
  await withSystem('test: activate expert', async (trx) => {
    await trx.updateTable('tenants').set({ status: 'active' }).where('id', '=', biz.tenantId).execute();
    await trx.updateTable('tenant_settings').set({ min_notice_min: 0, slot_increment_min: 30 }).where('tenant_id', '=', biz.tenantId).execute();
  });
  return { owner, slug: biz.slug, tenantId: biz.tenantId, me, service: svc.body.data.id as string };
}

describe('freelancer journey: listing → search → book & pay → client appointment → check-in/out → money', () => {
  it('product add-on leaves salon stock once at the frozen average; each party sees only its own money', async () => {
    // Host salon: VAT-registered, sandbox payments, unique city so the search is deterministic.
    const h = await makeSalon({ settings: { tax_rate_bp: 1500, prices_include_tax: false, tax_number: '300000000000003', legal_name: 'Host Salon LLC' } });
    const hp = { tenantSlug: h.slug };
    const city = `مدينة-${uniq()}`;
    await withSystem('test: host city', (trx) => trx.updateTable('branches').set({ city }).where('id', '=', h.branchId).execute());
    const chair = await chairResource(h.owner, h.slug, h.branchId, 'Chair 1');

    // Store product (40.00): 10 units at cost 10.00, then 10 more at 20.00 → average 15.00.
    const prod = await createProduct(h.owner, h.slug, { name_ar: 'سيروم', name_en: 'Serum' }, { price_minor: 4000, cost_minor: 1000, initial_stock: 10 });
    const variantId = prod.variants[0]!.id as string, itemId = prod.variants[0]!.inventory_item_id as string;
    const rec = await h.owner.call(itemMoves.POST, { params: { ...hp, id: itemId }, body: { kind: 'receipt', quantity: 10, unit_cost_minor: 2000 } });
    expect(rec.status, JSON.stringify(rec.body)).toBe(201);
    expect((await h.owner.call(itemOne.GET, { params: { ...hp, id: itemId } })).body.data).toMatchObject({ on_hand: 20, avg_cost_minor: 1500 });

    // Listing: instant, 50.00 per hour, product add-on with a 10% listing discount.
    const created = await h.owner.call(listings.POST, { params: hp, body: {
      branch_id: h.branchId, resource_id: chair, code: `C-${uniq().slice(0, 4)}`, title_ar: 'كرسي مكياج', space_type: 'chair', price_model: 'fixed_hour', price_minor: 5000,
      min_duration_min: 60, max_duration_min: 480, booking_mode: 'instant', addons_discount_bp: 1000,
      windows: Array.from({ length: 7 }, (_, d) => ({ weekday: d, start_time: '08:00', end_time: '22:00' })),
      access_instructions_ar: 'الاستقبال في الدور الأول', addons: [{ kind: 'product', product_variant_id: variantId, max_quantity: 5 }],
    } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const pub = await h.owner.call(listingStatus.POST, { params: { ...hp, id: created.body.data.id }, body: { status: 'published', version: created.body.data.version } });
    expect(pub.status, JSON.stringify(pub.body)).toBe(200);
    const listingId = pub.body.data.id as string;
    const addonId = (pub.body.data.addons as any[]).find((a) => a.kind === 'product')!.id as string;

    // Expert searches by city/date/time/duration and finds it with the base (chair-only) price.
    const x = await makeExpert();
    const xp = { tenantSlug: x.slug };
    const d = futureDate(5);
    const sr = await x.owner.call(search.GET, { params: xp, query: { city, date: d, start_time: '10:00', duration_min: '120' } });
    expect(sr.status, JSON.stringify(sr.body)).toBe(200);
    expect(sr.body.data.results).toHaveLength(1);
    const hit = sr.body.data.results[0];
    expect(hit).toMatchObject({ id: listingId, rent_minor: 10000, base_total_minor: 11500, branch: { city } });
    expect((await x.owner.call(search.GET, { params: xp, query: { city: `${city}-x`, date: d, start_time: '10:00', duration_min: '120' } })).body.data.results).toEqual([]);
    const det = await x.owner.call(wsListing.GET, { params: { ...xp, id: listingId }, query: { date: d, duration_min: '120' } });
    expect(det.status).toBe(200);
    expect(det.body.data.inclusions.materials).toEqual([]);
    expect(det.body.data.access_instructions_ar).toBeUndefined();

    // Quote: base 115.00 vs total with two serums: rent 100 + 80 − 8 discount = 172 + 15% tax = 197.80.
    const q = await x.owner.call(wsQuote.POST, { params: xp, body: { listing_id: listingId, duration_min: 120, addons: [{ addon_id: addonId, quantity: 2 }] } });
    expect(q.body.data).toMatchObject({ base_total_minor: 11500, rent_minor: 10000, addons_minor: 8000, discount_minor: 800, tax_minor: 2580, total_minor: 19780 });

    // Request (instant → held), pay through the sandbox → confirmed.
    const req = await x.owner.call(wsBookings.POST, { params: xp, idempotencyKey: true, body: {
      listing_id: listingId, start: iso(at(d, '10:00')), duration_min: 120, addons: [{ addon_id: addonId, quantity: 2 }], terms_version: hit.terms_version,
    } });
    expect(req.status, JSON.stringify(req.body)).toBe(201);
    expect(req.body.data.status).toBe('held');
    const wsId = req.body.data.id as string;
    expect((await h.owner.call(itemOne.GET, { params: { ...hp, id: itemId } })).body.data.on_hand).toBe(20); // nothing leaves before payment
    const co = await x.owner.call(wsCheckout.POST, { params: { ...xp, id: wsId }, body: {}, idempotencyKey: true });
    expect(co.status, JSON.stringify(co.body)).toBe(201);
    expect(co.body.data.payment.amount_minor).toBe(19780);
    const ref = co.body.data.payment.checkout_url.split('/sandbox/checkout/')[1].split('?')[0];
    expect((await x.owner.call(sandboxPay.POST, { params: { providerPaymentId: ref }, body: { outcome: 'captured' } })).body.data.webhook).toBe('processed');
    let w = (await x.owner.call(wsBooking.GET, { params: { ...xp, id: wsId } })).body.data;
    expect(w).toMatchObject({ status: 'confirmed', payment_status: 'paid', location_confirmed: true });
    expect(w.access_instructions.ar).toBe('الاستقبال في الدور الأول');

    // Her client appointment inside the window; the client sees the host branch as the place.
    const tc = await withTenant(x.tenantId, (trx) => trx.insertInto('tenant_customers').values({ tenant_id: x.tenantId, display_name: 'Bride Noor', source: 'walk_in' }).returning('id').executeTakeFirstOrThrow());
    const appt = await x.owner.call(wsAppointments.POST, { params: { ...xp, id: wsId }, idempotencyKey: true, body: {
      customer_id: tc.id, items: [{ key: 'a', service_id: x.service, staff_id: x.me, start: iso(at(d, '10:30')) }],
    } });
    expect(appt.status, JSON.stringify(appt.body)).toBe(201);
    w = (await x.owner.call(wsBooking.GET, { params: { ...xp, id: wsId } })).body.data;
    expect(w.linked_appointments).toHaveLength(1);
    const apptId = w.linked_appointments[0].id as string;
    const loc = await withTenant(x.tenantId, async (trx) => {
      const { appointmentLocation } = await import('@/server/domains/hosting/bookings');
      return appointmentLocation(trx, x.tenantId, wsId);
    });
    const hostBranch = await withSystem('test: host branch', (trx) => trx.selectFrom('branches').select(['name', 'city']).where('id', '=', h.branchId).executeTakeFirstOrThrow());
    expect(loc).toMatchObject({ confirmed: true, branch_name: hostBranch.name, city });

    // Check-in by code at the start, check-out by code on time.
    const { user: xu, access: xa } = await accessOf(x.owner, x.slug);
    const w0 = await hostingTx('test', (trx) => lockBooking(trx, wsId));
    await guestCheck(xa, { userId: xu.userId, kind: 'user' }, wsId, 'in', w0.check_in_code, new Date(w0.starts_at.getTime() + 60_000));
    const out = await guestCheck(xa, { userId: xu.userId, kind: 'user' }, wsId, 'out', w0.check_in_code, new Date(w0.ends_at.getTime() - 5 * 60_000));
    expect(out.status).toBe('completed');
    expect(out.statement.late_fees_proposed_minor).toBe(0);

    // Salon stock: exactly one sale movement for the add-on at the frozen average, one COGS posting.
    expect((await h.owner.call(itemOne.GET, { params: { ...hp, id: itemId } })).body.data.on_hand).toBe(18);
    const sales = await withTenant(h.tenantId, (trx) => trx.selectFrom('stock_movements').select(['id', 'kind', 'quantity', 'unit_cost_minor', 'total_cost_minor', 'ref_type'])
      .where('inventory_item_id', '=', itemId).where('kind', '=', 'sale').execute());
    expect(sales).toHaveLength(1);
    expect(sales[0]).toMatchObject({ ref_type: 'workspace_booking_line' });
    expect([Number(sales[0]!.quantity), Number(sales[0]!.unit_cost_minor), Number(sales[0]!.total_cost_minor)]).toEqual([-2, 1500, -3000]);
    const he = await entries(h.tenantId);
    const cogs = he.filter((e) => e.account === 'cogs');
    expect(cogs).toHaveLength(1);
    expect(cogs[0]).toMatchObject({ debit_minor: 3000, ref_type: 'stock_movement', ref_id: sales[0]!.id });
    const line = await withTenant(h.tenantId, (trx) => trx.selectFrom('workspace_booking_lines').select(['unit_cost_minor', 'inventory_item_id']).where('workspace_booking_id', '=', wsId).where('kind', '=', 'product').executeTakeFirstOrThrow());
    expect(Number(line.unit_cost_minor)).toBe(1500);
    expect(line.inventory_item_id).toBe(itemId);
    // A later cost edit never changes what was frozen.
    await h.owner.call(itemOne.PATCH, { params: { ...hp, id: itemId }, body: { cost_per_unit_minor: 9999 } });
    expect((await h.owner.call(financeReport.GET, { params: hp, query: { from: today(), to: today() } })).body.data.product_costs.amount_minor).toBe(3000);

    // Expert: expenses, no dues, settlement statement (rent + products − discount + tax).
    const xs = (await x.owner.call(wsSummary.GET, { params: xp })).body.data;
    expect(xs).toMatchObject({ hosting_expense_minor: 19780, dues_minor: 0 });
    expect(xs.per_host).toEqual([expect.objectContaining({ total_minor: 19780, count: 1 })]);
    const stmt = (await x.owner.call(wsBooking.GET, { params: { ...xp, id: wsId } })).body.data.statement;
    expect(stmt).toMatchObject({ rent_minor: 10000, products_minor: 8000, discounts_minor: 800, tax_minor: 2580, total_charges_minor: 19780, collected_minor: 19780, due_from_guest_minor: 0, credit_to_guest_minor: 0 });
    const xe = await entries(x.tenantId);
    expect(net(xe, 'hosting_expense')).toBe(19780);
    expect(net(xe, 'bank')).toBe(-19780);
    expect(unbalancedGroups(xe)).toEqual([]);

    // Invoice issued by the salon to the expert's business.
    expect(w.invoices).toHaveLength(1);
    const inv = (await x.owner.call(wsInvoice.GET, { params: { ...xp, id: wsId, invoiceId: w.invoices[0].id } })).body.data;
    expect(inv).toMatchObject({ buyer_tenant_id: x.tenantId, total_minor: 19780, tax_minor: 2580 });
    expect(inv.seller_snapshot.tax_number).toBe('300000000000003');

    // Salon: hosting revenue and add-on sales only — never the expert's client service revenue.
    const hs = (await h.owner.call(hostSummary.GET, { params: hp })).body.data;
    expect(hs).toMatchObject({ hosting_revenue_minor: 10000, product_addon_sales_minor: 8000, receivable_minor: 0 });
    expect(net(he, 'hosting_revenue')).toBe(-10000);
    expect(net(he, 'product_revenue')).toBe(-8000);
    expect(net(he, 'discounts')).toBe(800);
    expect(net(he, 'tax_payable')).toBe(-2580);
    expect(he.some((e) => e.account === 'service_revenue')).toBe(false);
    expect(unbalancedGroups(he)).toEqual([]);
    const settle = await h.owner.call(hostSettlement.POST, { params: { ...hp, id: wsId }, body: {} });
    expect(settle.status, JSON.stringify(settle.body)).toBe(200);
    expect(settle.body.data).toMatchObject({ settlement_status: 'settled', statement: { host_net_minor: 19780, platform_fee: { enabled: false, amount_minor: 0 } } });

    // D14: the host cannot see her client appointment, by API or by RLS.
    const hv = await h.owner.call(hostBooking.GET, { params: { ...hp, id: wsId } });
    expect(hv.status).toBe(200);
    expect(JSON.stringify(hv.body)).not.toMatch(/Bride Noor|linked_appointments|مكياج عروس|qr_token/);
    expect(JSON.stringify(hv.body)).not.toContain(apptId);
    expect(await withTenant(h.tenantId, (trx) => trx.selectFrom('bookings').select('id').where('id', '=', apptId).execute())).toEqual([]);
    expect((await h.owner.call(hostBookings.GET, { params: hp })).body.data.map((r: any) => r.id)).toEqual([wsId]);
    expect(await findStockMismatches(h.tenantId)).toEqual([]);
  });
});
