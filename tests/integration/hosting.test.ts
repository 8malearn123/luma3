import { describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { DateTime } from 'luxon';
import { at, customer, futureDate, makeSalon, type Salon } from '../helpers/salon';
import { createBusinessFor, signup } from '../helpers/factory';
import { createProduct } from '../helpers/commerce';
import type { TestClient } from '../helpers/http';
import { withSystem, withTenant } from '@/server/db/client';
import { resolveSession, SESSION_COOKIE } from '@/server/auth/service';
import { resolveTenantAccess } from '@/server/tenancy/access';
import { decideRequest, guestCheck, hostCheck } from '@/server/domains/hosting/bookings';
import { hostingTx, lockBooking } from '@/server/domains/hosting/scope';
import { cancellationOutcome, lateFee, quote, rentFor, WS_TRANSITIONS, canTransition } from '@/shared/schemas/hosting';
import * as resourceTypes from '@/app/api/v1/t/[tenantSlug]/resource-types/route';
import * as resources from '@/app/api/v1/t/[tenantSlug]/resources/route';
import * as services from '@/app/api/v1/t/[tenantSlug]/services/route';
import * as schedule from '@/app/api/v1/t/[tenantSlug]/staff/[id]/schedule/route';
import * as accounts from '@/app/api/v1/t/[tenantSlug]/payment-accounts/route';
import * as reauth from '@/app/api/v1/auth/reauth/route';
import * as hold from '@/app/api/v1/s/[slug]/bookings/route';
import * as holdCheckout from '@/app/api/v1/s/[slug]/bookings/[id]/checkout/route';
import * as tTransition from '@/app/api/v1/t/[tenantSlug]/bookings/[id]/transition/route';
import * as sandboxPay from '@/app/api/v1/sandbox/checkout/[providerPaymentId]/route';
import * as sandboxRefund from '@/app/api/v1/sandbox/refunds/[providerRefundId]/route';
import * as links from '@/app/api/v1/t/[tenantSlug]/hosting/links/route';
import * as listings from '@/app/api/v1/t/[tenantSlug]/hosting/listings/route';
import * as listingOne from '@/app/api/v1/t/[tenantSlug]/hosting/listings/[id]/route';
import * as listingStatus from '@/app/api/v1/t/[tenantSlug]/hosting/listings/[id]/status/route';
import * as listingAvail from '@/app/api/v1/t/[tenantSlug]/hosting/listings/[id]/availability/route';
import * as hostBookings from '@/app/api/v1/t/[tenantSlug]/hosting/bookings/route';
import * as hostBooking from '@/app/api/v1/t/[tenantSlug]/hosting/bookings/[id]/route';
import * as hostDecision from '@/app/api/v1/t/[tenantSlug]/hosting/bookings/[id]/decision/route';
import * as hostLateFee from '@/app/api/v1/t/[tenantSlug]/hosting/bookings/[id]/late-fees/[lineId]/route';
import * as hostSettlement from '@/app/api/v1/t/[tenantSlug]/hosting/bookings/[id]/settlement/route';
import * as hostCorrection from '@/app/api/v1/t/[tenantSlug]/hosting/bookings/[id]/corrections/route';
import * as hostMaterial from '@/app/api/v1/t/[tenantSlug]/hosting/bookings/[id]/materials/[requestId]/route';
import * as hostScan from '@/app/api/v1/t/[tenantSlug]/hosting/scan/route';
import * as hostSummary from '@/app/api/v1/t/[tenantSlug]/hosting/summary/route';
import * as search from '@/app/api/v1/t/[tenantSlug]/workspace/search/route';
import * as wsListing from '@/app/api/v1/t/[tenantSlug]/workspace/listings/[id]/route';
import * as wsQuote from '@/app/api/v1/t/[tenantSlug]/workspace/quote/route';
import * as wsBookings from '@/app/api/v1/t/[tenantSlug]/workspace/bookings/route';
import * as wsBooking from '@/app/api/v1/t/[tenantSlug]/workspace/bookings/[id]/route';
import * as wsCheckout from '@/app/api/v1/t/[tenantSlug]/workspace/bookings/[id]/checkout/route';
import * as wsDues from '@/app/api/v1/t/[tenantSlug]/workspace/bookings/[id]/pay-dues/route';
import * as wsCancel from '@/app/api/v1/t/[tenantSlug]/workspace/bookings/[id]/cancel/route';
import * as wsMaterials from '@/app/api/v1/t/[tenantSlug]/workspace/bookings/[id]/materials/route';
import * as wsReview from '@/app/api/v1/t/[tenantSlug]/workspace/bookings/[id]/review/route';
import * as wsInvoice from '@/app/api/v1/t/[tenantSlug]/workspace/bookings/[id]/invoices/[invoiceId]/route';
import * as wsAppointments from '@/app/api/v1/t/[tenantSlug]/workspace/bookings/[id]/appointments/route';
import * as wsSummary from '@/app/api/v1/t/[tenantSlug]/workspace/summary/route';

// ── Fixtures ─────────────────────────────────────────────────────────────────
const WEEK = Array.from({ length: 7 }, (_, d) => ({ weekday: d, start_time: '08:00', end_time: '22:00' }));
const iso = (s: string) => new Date(s).toISOString();

type Host = Salon & { chair1: string; chair2: string; dryer: string; variantId: string; itemId: string; access: () => ReturnType<typeof resolveTenantAccess> };

async function accessOf(c: TestClient, slug: string) {
  const user = (await resolveSession(c.cookies.get(SESSION_COOKIE)))!;
  return resolveTenantAccess(user, slug);
}
const actorOf = async (c: TestClient) => ({ userId: (await resolveSession(c.cookies.get(SESSION_COOKIE)))!.userId, kind: 'user' as const });

async function makeHost(opts: { vat?: boolean } = {}): Promise<Host> {
  const s = await makeSalon({ settings: { tax_rate_bp: 1500, prices_include_tax: false, ...(opts.vat ? { tax_number: '300000000000003', legal_name: 'Host Salon LLC' } : {}) } });
  const p = { tenantSlug: s.slug };
  const type = await s.owner.call(resourceTypes.POST, { params: p, body: { name_ar: 'كرسي', name_en: 'Chair' } });
  expect(type.status).toBe(201);
  const dev = await s.owner.call(resourceTypes.POST, { params: p, body: { name_en: 'Device' } });
  const mk = async (name: string, typeId: string) => {
    const r = await s.owner.call(resources.POST, { params: p, body: { branch_id: s.branchId, resource_type_id: typeId, name } });
    expect(r.status).toBe(201);
    return r.body.data.id as string;
  };
  const chair1 = await mk('Chair 1', type.body.data.id), chair2 = await mk('Chair 2', type.body.data.id), dryer = await mk('Dryer', dev.body.data.id);
  const prod = await createProduct(s.owner, s.slug, { name_ar: 'سيروم', name_en: 'Serum' }, { price_minor: 4000, initial_stock: 10 });
  return { ...s, chair1, chair2, dryer, variantId: prod.variants[0]!.id, itemId: prod.variants[0]!.inventory_item_id, access: () => accessOf(s.owner, s.slug) };
}

async function listSpace(h: Host, over: Record<string, unknown> = {}) {
  const r = await h.owner.call(listings.POST, { params: { tenantSlug: h.slug }, body: {
    branch_id: h.branchId, resource_id: h.chair1, code: `C-${Math.random().toString(36).slice(2, 6)}`, title_ar: 'كرسي قص', space_type: 'chair', price_model: 'fixed_hour', price_minor: 5000,
    min_duration_min: 60, max_duration_min: 480, booking_mode: 'instant', windows: WEEK, addons_discount_bp: 1000,
    cancellation_terms: { free_until_hours: 24, fee_bp: 5000 }, late_terms: { grace_min: 10, mode: 'per_15min', amount_minor: 1000 },
    access_instructions_ar: 'ادخلي من الباب الخلفي', addons: [
      { kind: 'product', product_variant_id: h.variantId, max_quantity: 5 },
      { kind: 'equipment', resource_id: h.dryer, name_en: 'Dryer', rental_price_minor: 2000, rental_unit: 'booking' },
    ], ...over,
  } });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const pub = await h.owner.call(listingStatus.POST, { params: { tenantSlug: h.slug, id: r.body.data.id }, body: { status: 'published', version: r.body.data.version } });
  expect(pub.status, JSON.stringify(pub.body)).toBe(200);
  return pub.body.data as { id: string; version: number; terms_version: number; addons: Array<{ id: string; kind: string }> };
}

/** An independent expert (owner is her own provider) working 08:00–23:00, with one service and sandbox payments. */
async function makeExpert() {
  const owner = await signup('Expert');
  const biz = await createBusinessFor(owner, { business_type: 'expert', plan_code: 'sanaa' });
  const p = { tenantSlug: biz.slug };
  const me = biz.staffProfileId!;
  await owner.call(schedule.PUT, { params: { ...p, id: me }, body: { branch_id: biz.branchId, ranges: Array.from({ length: 7 }, (_, d) => ({ weekday: d, start_time: '08:00', end_time: '23:00' })), breaks: [] } });
  const svc = await owner.call(services.POST, { params: p, body: { name_ar: 'مكياج', price_minor: 30000, duration_min: 60, staff: [{ staff_id: me }] } });
  await owner.call(reauth.POST, { body: { password: 'correct horse battery' } });
  await owner.call(accounts.POST, { params: p, body: { provider: 'sandbox' } });
  await withSystem('test: activate expert', async (trx) => {
    await trx.updateTable('tenants').set({ status: 'active' }).where('id', '=', biz.tenantId).execute();
    await trx.updateTable('tenant_settings').set({ min_notice_min: 0, slot_increment_min: 30 }).where('tenant_id', '=', biz.tenantId).execute();
  });
  return { owner, slug: biz.slug, tenantId: biz.tenantId, branchId: biz.branchId, me, service: svc.body.data.id as string };
}
type Expert = Awaited<ReturnType<typeof makeExpert>>;

const request = (x: Expert, listingId: string, start: string, duration = 120, extra: Record<string, unknown> = {}) =>
  x.owner.call(wsBookings.POST, { params: { tenantSlug: x.slug }, body: { listing_id: listingId, start: iso(start), duration_min: duration, ...extra }, idempotencyKey: true });

async function payFor(x: Expert, id: string, path: 'checkout' | 'dues' = 'checkout') {
  const co = await x.owner.call(path === 'checkout' ? wsCheckout.POST : wsDues.POST, { params: { tenantSlug: x.slug, id }, body: {}, idempotencyKey: true });
  expect(co.status, JSON.stringify(co.body)).toBe(201);
  const ref = co.body.data.payment.checkout_url.split('/sandbox/checkout/')[1].split('?')[0];
  const done = await x.owner.call(sandboxPay.POST, { params: { providerPaymentId: ref }, body: { outcome: 'captured' } });
  expect(done.body.data.webhook).toBe('processed');
  return co.body.data.payment as { id: string; amount_minor: number };
}

async function bookAndPay(x: Expert, listingId: string, start: string, duration = 120, extra: Record<string, unknown> = {}) {
  const r = await request(x, listingId, start, duration, extra);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  await payFor(x, r.body.data.id);
  const g = await x.owner.call(wsBooking.GET, { params: { tenantSlug: x.slug, id: r.body.data.id } });
  expect(g.body.data.status).toBe('confirmed');
  return g.body.data;
}

/** A confirmed client appointment of the expert at her own studio. */
async function clientAppointment(x: Expert, start: string) {
  const c = await customer('Bride');
  const h = await c.call(hold.POST, { params: { slug: x.slug }, body: { items: [{ key: 'a', service_id: x.service, staff_id: x.me, start: iso(start) }] }, idempotencyKey: true });
  expect(h.status, JSON.stringify(h.body)).toBe(201);
  const co = await c.call(holdCheckout.POST, { params: { slug: x.slug, id: h.body.data.booking_id }, body: { option: 'on_site' }, idempotencyKey: true });
  expect(co.body.data.status).toBe('confirmed');
  return h.body.data.booking_id as string;
}

const entries = (tenantId: string) => withTenant(tenantId, (trx) => trx.selectFrom('financial_entries').select(['account', 'debit_minor', 'credit_minor', 'ref_type']).execute());
const stockOf = (h: Host) => withTenant(h.tenantId, (trx) => trx.selectFrom('inventory_items').select(['on_hand']).where('id', '=', h.itemId).executeTakeFirstOrThrow());

// ── Pure rules ───────────────────────────────────────────────────────────────
describe('hosting pricing and state machine (pure)', () => {
  it('fixed price models only; add-ons at store price minus listing discount; tax on top', () => {
    expect(rentFor({ price_model: 'fixed_hour', price_minor: 5000, period_min: null }, 90).amount).toBe(7500);
    expect(rentFor({ price_model: 'fixed_period', price_minor: 12000, period_min: 240 }, 300).amount).toBe(24000);
    expect(rentFor({ price_model: 'fixed_day', price_minor: 30000, period_min: null }, 480).amount).toBe(30000);
    expect(() => rentFor({ price_model: 'percent', price_minor: 0, period_min: null }, 60)).toThrow('price_model_disabled');
    const q = quote({ price_model: 'fixed_hour', price_minor: 5000, period_min: null, addons_discount_bp: 1000 }, 120,
      [{ addon_id: 'p', kind: 'product', name: 'Serum', quantity: 2, unit_price_minor: 4000, rental_unit: null }], { rate_bp: 1500, prices_include_tax: false });
    expect(q.rent_minor).toBe(10000);
    expect(q.addons_minor).toBe(8000);
    expect(q.discount_minor).toBe(800);
    expect(q.tax_minor).toBe(Math.round(17200 * 0.15));
    expect(q.total_minor).toBe(17200 + 2580);
    expect(q.base_total_minor).toBe(11500);
  });

  it('late fee per started 15 minutes after grace; cancellation fee on rent only', () => {
    expect(lateFee({ grace_min: 10, mode: 'per_15min', amount_minor: 1000 }, 10)).toBe(0);
    expect(lateFee({ grace_min: 10, mode: 'per_15min', amount_minor: 1000 }, 26)).toBe(2000);
    expect(lateFee({ grace_min: 0, mode: 'flat', amount_minor: 3000 }, 1)).toBe(3000);
    const now = new Date('2030-01-01T10:00:00Z');
    expect(cancellationOutcome({ by: 'guest', terms: { free_until_hours: 24, fee_bp: 5000 }, paidMinor: 20000, rentGrossMinor: 10000, startsAt: new Date('2030-01-01T12:00:00Z'), now }))
      .toEqual({ refundMinor: 15000, feeMinor: 5000, basis: 'late_cancellation' });
    expect(cancellationOutcome({ by: 'host', terms: { free_until_hours: 24, fee_bp: 5000 }, paidMinor: 20000, rentGrossMinor: 10000, startsAt: new Date('2030-01-01T12:00:00Z'), now }).refundMinor).toBe(20000);
  });

  it('transition table names who may trigger each step', () => {
    expect(canTransition('approve', 'pending_approval', 'host')).toBe(true);
    expect(canTransition('approve', 'pending_approval', 'guest')).toBe(false);
    expect(canTransition('payment_captured', 'pending_payment', 'system')).toBe(true);
    expect(canTransition('check_in', 'held', 'host')).toBe(false);
    expect(WS_TRANSITIONS.expire.to).toBe('expired');
  });
});

// ── Listings ─────────────────────────────────────────────────────────────────
describe('listings', () => {
  it('percentage pricing is rejected; publishing needs an active payment account and the plan', async () => {
    const h = await makeHost();
    const bad = await h.owner.call(listings.POST, { params: { tenantSlug: h.slug }, body: { branch_id: h.branchId, resource_id: h.chair1, code: 'X', price_model: 'percent', price_minor: 0, percent_bp: 2000 } });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('price_model_disabled');
    const ok = await h.owner.call(listings.POST, { params: { tenantSlug: h.slug }, body: { branch_id: h.branchId, resource_id: h.chair1, code: 'A1', price_minor: 5000, windows: WEEK } });
    expect(ok.status).toBe(201);
    await withTenant(h.tenantId, (trx) => trx.updateTable('payment_accounts').set({ status: 'disconnected' }).execute());
    const pub = await h.owner.call(listingStatus.POST, { params: { tenantSlug: h.slug, id: ok.body.data.id }, body: { status: 'published', version: ok.body.data.version } });
    expect(pub.status).toBe(422);
    expect(pub.body.error.code).toBe('payment_account_required');
  });
});

// ── Availability & conflicts ─────────────────────────────────────────────────
describe('availability and conflicts', () => {
  it('a chair booked internally (via a linked specialist) is not available for rent in that period', async () => {
    const h = await makeHost();
    const l = await listSpace(h);
    expect((await h.owner.call(links.PUT, { params: { tenantSlug: h.slug }, body: { resource_id: h.chair1, staff_ids: [h.staff.sara] } })).status).toBe(200);
    const d = futureDate(6);
    const c = await customer();
    const b = await c.call(hold.POST, { params: { slug: h.slug }, body: { items: [{ key: 'a', service_id: h.services.haircut, staff_id: h.staff.sara, start: iso(at(d, '10:00')) }] }, idempotencyKey: true });
    expect(b.status).toBe(201);
    // The internal booking engine reserved the linked chair together with the specialist.
    const alloc = await withTenant(h.tenantId, (trx) => trx.selectFrom('booking_allocations').select(['resource_id']).where('booking_id', '=', b.body.data.booking_id).where('resource_id', 'is not', null).execute());
    expect(alloc.map((a) => a.resource_id)).toEqual([h.chair1]);

    const x = await makeExpert();
    const busy = await request(x, l.id, at(d, '10:00'), 60);
    expect(busy.status).toBe(409);
    const sr = await x.owner.call(search.GET, { params: { tenantSlug: x.slug }, query: { date: d, start_time: '10:00', duration_min: '60' } });
    expect(sr.status).toBe(200);
    expect(sr.body.data.results.map((r: any) => r.id)).not.toContain(l.id);
    const free = await x.owner.call(search.GET, { params: { tenantSlug: x.slug }, query: { date: d, start_time: '12:00', duration_min: '60' } });
    expect(free.body.data.results.map((r: any) => r.id)).toContain(l.id);
    expect(JSON.stringify(free.body)).not.toMatch(/Sara|customer/);

    // The host's internal-vs-rentable view shows the internal use.
    const v = await h.owner.call(listingAvail.GET, { params: { tenantSlug: h.slug, id: l.id }, query: { date: d } });
    expect(v.body.data.busy.some((x2: any) => x2.kind === 'internal')).toBe(true);

    // Conversely: once the chair is rented, the linked specialist cannot be booked on it at that time.
    const ok = await request(x, l.id, at(d, '13:00'), 60);
    expect(ok.status).toBe(201);
    const c2 = await customer();
    const clash = await c2.call(hold.POST, { params: { slug: h.slug }, body: { items: [{ key: 'a', service_id: h.services.haircut, staff_id: h.staff.sara, start: iso(at(d, '13:00')) }] }, idempotencyKey: true });
    expect(clash.status).toBe(409);
    // Huda has no chair link: unaffected.
    const huda = await c2.call(hold.POST, { params: { slug: h.slug }, body: { items: [{ key: 'a', service_id: h.services.haircut, staff_id: h.staff.huda, start: iso(at(d, '13:00')) }] }, idempotencyKey: true });
    expect(huda.status).toBe(201);
  });

  it('two concurrent requests for the same space and time: exactly one succeeds', async () => {
    const h = await makeHost();
    const l = await listSpace(h);
    const [a, b] = await Promise.all([makeExpert(), makeExpert()]);
    const d = futureDate(7);
    const rs = await Promise.all([request(a, l.id, at(d, '10:00')), request(b, l.id, at(d, '10:00'))]);
    expect(rs.map((r) => r.status).sort()).toEqual([201, 409]);
    const n = await withSystem('test', (trx) => trx.selectFrom('booking_allocations').select(sql<number>`count(*)::int`.as('n')).where('resource_id', '=', h.chair1).where('state', 'in', ['held', 'confirmed']).executeTakeFirstOrThrow());
    expect(n.n).toBe(1);
  });

  it('shared equipment busy blocks a booking that needs it', async () => {
    const h = await makeHost();
    const l1 = await listSpace(h);
    const l2 = await listSpace(h, { resource_id: h.chair2 });
    const dryer1 = l1.addons.find((a) => a.kind === 'equipment')!.id;
    const dryer2 = l2.addons.find((a) => a.kind === 'equipment')!.id;
    const [a, b] = await Promise.all([makeExpert(), makeExpert()]);
    const d = futureDate(8);
    expect((await request(a, l1.id, at(d, '14:00'), 120, { addons: [{ addon_id: dryer1, quantity: 1 }] })).status).toBe(201);
    const r = await request(b, l2.id, at(d, '15:00'), 60, { addons: [{ addon_id: dryer2, quantity: 1 }] });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('equipment_unavailable');
    expect((await request(b, l2.id, at(d, '15:00'), 60)).status).toBe(201);
  });

  it('an expert cannot double-book herself across two salons or against her own client appointments', async () => {
    const [h1, h2] = await Promise.all([makeHost(), makeHost()]);
    const [l1, l2] = [await listSpace(h1), await listSpace(h2)];
    const x = await makeExpert();
    const d = futureDate(9);
    expect((await request(x, l1.id, at(d, '10:00'), 120)).status).toBe(201);
    const twice = await request(x, l2.id, at(d, '11:00'), 120);
    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe('guest_busy');
    await clientAppointment(x, at(d, '16:00'));
    const overOwn = await request(x, l2.id, at(d, '15:30'), 120);
    expect(overOwn.body.error.code).toBe('guest_busy');
    // And her own studio cannot take a client while she is at the salon.
    const c = await customer();
    const h = await c.call(hold.POST, { params: { slug: x.slug }, body: { items: [{ key: 'a', service_id: x.service, staff_id: x.me, start: iso(at(d, '10:30')) }] }, idempotencyKey: true });
    expect(h.status).toBe(409);
  });
});

// ── Lifecycle, money, privacy ────────────────────────────────────────────────
describe('space booking lifecycle and money', () => {
  it('instant booking → pay → confirmed; terms changes never reprice; invoice to the expert business; journals per party', async () => {
    const h = await makeHost({ vat: true });
    const l = await listSpace(h);
    const x = await makeExpert();
    const d = futureDate(10);
    const product = l.addons.find((a) => a.kind === 'product')!.id;
    const q = await x.owner.call(wsQuote.POST, { params: { tenantSlug: x.slug }, body: { listing_id: l.id, duration_min: 120, addons: [{ addon_id: product, quantity: 2 }] } });
    expect(q.body.data.base_total_minor).toBe(11500);
    expect(q.body.data.total_minor).toBe(19780);
    const before = await stockOf(h);
    const w = await bookAndPay(x, l.id, at(d, '10:00'), 120, { addons: [{ addon_id: product, quantity: 2 }], terms_version: l.terms_version });
    expect(w.total_minor).toBe(19780);
    expect(w.access_instructions.ar).toBe('ادخلي من الباب الخلفي');
    expect(w.qr_token).toBeTruthy();
    // Product add-on: deducted once, at store price minus the listing discount.
    expect((await stockOf(h)).on_hand).toBe(before.on_hand - 2);
    const lines = w.statement.lines;
    expect(lines.find((x2: any) => x2.kind === 'product').amount_minor).toBe(8000);
    expect(lines.find((x2: any) => x2.kind === 'discount').amount_minor).toBe(-800);
    const sales = await withTenant(h.tenantId, (trx) => trx.selectFrom('stock_movements').select(['kind', 'quantity', 'ref_type']).where('inventory_item_id', '=', h.itemId).where('ref_type', '=', 'workspace_booking_line').execute());
    expect(sales).toEqual([{ kind: 'sale', quantity: -2, ref_type: 'workspace_booking_line' }]);

    // The listing changes afterwards: the confirmed booking keeps its frozen terms.
    const cur = await h.owner.call(listingOne.GET, { params: { tenantSlug: h.slug, id: l.id } });
    const upd = await h.owner.call(listingOne.PATCH, { params: { tenantSlug: h.slug, id: l.id }, body: { price_minor: 9000, version: cur.body.data.version, cancellation_terms: { free_until_hours: 0, fee_bp: 0 } } });
    expect(upd.status).toBe(200);
    const after = await x.owner.call(wsBooking.GET, { params: { tenantSlug: x.slug, id: w.id } });
    expect(after.body.data.total_minor).toBe(19780);
    expect(after.body.data.terms.price_minor).toBe(5000);
    expect(after.body.data.terms.cancellation_terms.fee_bp).toBe(5000);
    const stale = await request(x, l.id, at(d, '18:00'), 60, { terms_version: l.terms_version });
    expect(stale.body.error.code).toBe('terms_changed');

    // D13: an invoice from the salon to the expert's business, a tax invoice since the salon is VAT-registered.
    expect(after.body.data.invoices).toHaveLength(1);
    const inv = await x.owner.call(wsInvoice.GET, { params: { tenantSlug: x.slug, id: w.id, invoiceId: after.body.data.invoices[0].id } });
    expect(inv.status).toBe(200);
    expect(inv.body.data.buyer_tenant_id).toBe(x.tenantId);
    expect(inv.body.data.seller_snapshot.tax_number).toBe('300000000000003');
    expect(inv.body.data.total_minor).toBe(19780);
    expect(inv.body.data.tax_minor).toBe(2580);

    // Journals: host earns hosting revenue (+ product revenue, tax); guest records a hosting expense.
    const he = await entries(h.tenantId);
    const sum = (es: typeof he, acc: string, side: 'credit_minor' | 'debit_minor') => es.filter((e) => e.account === acc).reduce((a, e) => a + e[side], 0);
    expect(sum(he, 'hosting_revenue', 'credit_minor')).toBe(10000);
    expect(sum(he, 'product_revenue', 'credit_minor')).toBe(8000);
    expect(sum(he, 'discounts', 'debit_minor')).toBe(800);
    expect(sum(he, 'tax_payable', 'credit_minor')).toBe(2580);
    const ge = await entries(x.tenantId);
    expect(sum(ge, 'hosting_expense', 'debit_minor')).toBe(19780);
    expect(sum(ge, 'bank', 'credit_minor')).toBe(19780);

    const summary = await x.owner.call(wsSummary.GET, { params: { tenantSlug: x.slug } });
    expect(summary.body.data.hosting_expense_minor).toBe(19780);
    const hs = await h.owner.call(hostSummary.GET, { params: { tenantSlug: h.slug } });
    expect(hs.body.data.hosting_revenue_minor).toBe(10000);

    // Loom export: host occupancy (freelancer vs internal), revenue, idle time; guest cost per host — tenant-scoped.
    const occ = await withTenant(h.tenantId, (trx) => sql<{ usage: string }>`select usage from loom_export.hosting_occupancy`.execute(trx));
    expect(occ.rows.map((r) => r.usage)).toContain('freelancer');
    const rev = await withTenant(h.tenantId, (trx) => sql<{ total_minor: number; guest_ref: string }>`select total_minor, guest_ref from loom_export.hosting_revenue`.execute(trx));
    expect(rev.rows[0]!.total_minor).toBe(19780);
    expect(rev.rows[0]!.guest_ref).not.toContain(x.tenantId);
    const idle = await withTenant(h.tenantId, (trx) => sql<{ listed_min: number; booked_min: number; day: string }>`select listed_min, booked_min, day::text as day from loom_export.hosting_idle where booked_min > 0`.execute(trx));
    expect(idle.rows).toEqual([{ listed_min: 840, booked_min: 120, day: d }]);
    const cost = await withTenant(x.tenantId, (trx) => sql<{ host_name: string; total_minor: number }>`select host_name, total_minor from loom_export.workspace_costs`.execute(trx));
    expect(cost.rows).toEqual([{ host_name: expect.any(String), total_minor: 19780 }]);
    const none = await withTenant(x.tenantId, (trx) => sql`select 1 from loom_export.hosting_revenue`.execute(trx));
    expect(none.rows).toEqual([]);
  });

  it('client appointments inside the space: host sees none of them; client cancellation keeps the space; salon books only hosting revenue', async () => {
    const h = await makeHost();
    const l = await listSpace(h);
    const x = await makeExpert();
    const d = futureDate(11);
    // Journey 2: a client appointment exists first; the space is booked around it and linked atomically.
    const first = await clientAppointment(x, at(d, '15:00'));
    const sr = await x.owner.call(search.GET, { params: { tenantSlug: x.slug }, query: { date: d, booking_id: first } });
    expect(sr.body.data.start_time).toBe('15:00');
    expect(sr.body.data.results.map((r: any) => r.id)).toContain(l.id);
    const w = await bookAndPay(x, l.id, at(d, '14:30'), 180, { link_booking_ids: [first] });
    expect(w.linked_appointments.map((b: any) => b.id)).toEqual([first]);
    // Journey 1: add another client appointment inside the confirmed window.
    const tc = await withTenant(x.tenantId, (trx) => trx.selectFrom('bookings').select('tenant_customer_id').where('id', '=', first).executeTakeFirstOrThrow());
    const second = await x.owner.call(wsAppointments.POST, { params: { tenantSlug: x.slug, id: w.id }, idempotencyKey: true, body: {
      customer_id: tc.tenant_customer_id, items: [{ key: 'a', service_id: x.service, staff_id: x.me, start: iso(at(d, '16:00')) }],
    } });
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    const outside = await x.owner.call(wsAppointments.POST, { params: { tenantSlug: x.slug, id: w.id }, idempotencyKey: true, body: {
      customer_id: tc.tenant_customer_id, items: [{ key: 'a', service_id: x.service, staff_id: x.me, start: iso(at(d, '17:00')) }],
    } });
    expect(outside.body.error.code).toBe('outside_workspace_window');

    // D14: the host cannot read the expert's client appointments, not even through RLS.
    const seen = await withTenant(h.tenantId, (trx) => trx.selectFrom('bookings').select('id').where('workspace_booking_id', '=', w.id).execute());
    expect(seen).toEqual([]);
    const hv = await h.owner.call(hostBooking.GET, { params: { tenantSlug: h.slug, id: w.id } });
    expect(hv.status).toBe(200);
    expect(JSON.stringify(hv.body)).not.toMatch(/Bride|linked_appointments|qr_token|مكياج/);
    expect(hv.body.data.qr_token).toBeUndefined();

    // D10: the client cancels; the space booking stays.
    const cancel = await x.owner.call(tTransition.POST, { params: { tenantSlug: x.slug, id: first }, body: { action: 'cancel', reason: 'client changed plans' } });
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);
    expect((await x.owner.call(wsBooking.GET, { params: { tenantSlug: x.slug, id: w.id } })).body.data.status).toBe('confirmed');

    // The client sees the host salon as a confirmed location (customer booking view).
    const { customerBookingDetail } = await import('@/server/domains/booking/customer');
    const cb = await withTenant(x.tenantId, (trx) => trx.selectFrom('bookings').select('customer_user_id').where('id', '=', first).executeTakeFirstOrThrow());
    const view = await customerBookingDetail(cb.customer_user_id!, first);
    expect(view.location).toMatchObject({ confirmed: true });

    // Revenue: the salon's journal has hosting revenue only — never the expert's client service revenue (D3).
    const he = await entries(h.tenantId);
    expect(he.some((e) => e.account === 'service_revenue')).toBe(false);
    expect(he.some((e) => e.account === 'hosting_revenue')).toBe(true);
  });

  it('own materials never touch salon stock', async () => {
    const h = await makeHost();
    const l = await listSpace(h);
    const x = await makeExpert();
    const before = await stockOf(h);
    await bookAndPay(x, l.id, at(futureDate(12), '10:00'));
    expect((await stockOf(h)).on_hand).toBe(before.on_hand);
    const mv = await withTenant(h.tenantId, (trx) => trx.selectFrom('stock_movements').select('id').where('inventory_item_id', '=', h.itemId).where('ref_type', '=', 'workspace_booking_line').execute());
    expect(mv).toEqual([]);
  });

  it('approval mode: the request holds the chair for 2 hours, then expires and frees it', async () => {
    const h = await makeHost();
    const l = await listSpace(h, { booking_mode: 'approval' });
    const x = await makeExpert();
    const d = futureDate(13);
    const r = await request(x, l.id, at(d, '10:00'));
    expect(r.status).toBe(201);
    expect(r.body.data.status).toBe('pending_approval');
    const deadline = new Date(r.body.data.approval_deadline).getTime();
    expect(Math.abs(deadline - (Date.now() + 2 * 3_600_000))).toBeLessThan(60_000);
    const access = await h.access();
    const actor = await actorOf(h.owner);
    const late = await decideRequest(access, actor, r.body.data.id, { approve: true }, new Date(Date.now() + 121 * 60_000)).catch((e) => e);
    expect(late.code).toBe('request_expired');
    const w = await hostingTx('test', (trx) => lockBooking(trx, r.body.data.id));
    expect(w.status).toBe('expired');
    const allocs = await withSystem('test', (trx) => trx.selectFrom('booking_allocations').select('state').where('workspace_booking_id', '=', w.id).execute());
    expect(allocs.every((a) => a.state === 'released')).toBe(true);
    // The chair is free again for someone else.
    expect((await request(await makeExpert(), l.id, at(d, '10:00'))).status).toBe(201);
  });

  it('approval mode: host approves in time, expert pays, settlement with a late fee that counts only once approved', async () => {
    const h = await makeHost();
    const l = await listSpace(h, { booking_mode: 'approval' });
    const x = await makeExpert();
    const d = futureDate(14);
    const r = await request(x, l.id, at(d, '10:00'), 120);
    const ap = await h.owner.call(hostDecision.POST, { params: { tenantSlug: h.slug, id: r.body.data.id }, body: { approve: true } });
    expect(ap.status).toBe(200);
    expect(ap.body.data.status).toBe('held');
    await payFor(x, r.body.data.id);
    const id = r.body.data.id as string;
    const w0 = await hostingTx('test', (trx) => lockBooking(trx, id));

    // Check in with the reception code (guest) and check out 40 minutes late (host): late fee is only proposed.
    const xa = await accessOf(x.owner, x.slug);
    const wrong = await guestCheck(xa, await actorOf(x.owner), id, 'in', '000000', new Date(w0.starts_at.getTime() + 60_000)).catch((e) => e);
    if (w0.check_in_code !== '000000') expect(wrong.code).toBe('invalid_code');
    await guestCheck(xa, await actorOf(x.owner), id, 'in', w0.check_in_code, new Date(w0.starts_at.getTime() + 60_000));
    const ha = await h.access();
    const out = await hostCheck(ha, await actorOf(h.owner), id, 'out', new Date(w0.ends_at.getTime() + 40 * 60_000));
    expect(out.status).toBe('completed');
    expect(out.statement.late_fees_minor).toBe(0);
    expect(out.statement.late_fees_proposed_minor).toBe(2000);
    const settleEarly = await h.owner.call(hostSettlement.POST, { params: { tenantSlug: h.slug, id }, body: {} });
    expect(settleEarly.body.error.code).toBe('late_fee_pending');
    const fee = out.statement.lines.find((x2: any) => x2.kind === 'late_fee');
    const ok = await h.owner.call(hostLateFee.POST, { params: { tenantSlug: h.slug, id, lineId: fee!.id }, body: { approve: true } });
    expect(ok.status).toBe(200);
    expect(ok.body.data.statement.late_fees_minor).toBe(2000);
    expect(ok.body.data.statement.due_from_guest_minor).toBe(2300);
    const he = await entries(h.tenantId);
    expect(he.filter((e) => e.account === 'hosting_receivable').reduce((a, e) => a + e.debit_minor, 0)).toBe(2300);

    // Expert pays the dues; settlement approved and immutable; a correction is a separate record.
    await payFor(x, id, 'dues');
    const st = await h.owner.call(hostSettlement.POST, { params: { tenantSlug: h.slug, id }, body: {} });
    expect(st.status).toBe(200);
    expect(st.body.data.settlement_status).toBe('settled');
    expect(st.body.data.statement.platform_fee).toEqual({ enabled: false, bp: 0, amount_minor: 0 });
    expect(st.body.data.statement.salon_percentage).toEqual({ enabled: false, amount_minor: 0 });
    await expect(withTenant(h.tenantId, (trx) => trx.updateTable('workspace_settlements').set({ version: 9 }).where('workspace_booking_id', '=', id).execute())).rejects.toThrow();
    const corr = await h.owner.call(hostCorrection.POST, { params: { tenantSlug: h.slug, id }, body: { amount_minor: 500, description: 'Extra towel service' } });
    expect(corr.status).toBe(200);
    expect(corr.body.data.settlement_status).toBe('corrected');
    expect(corr.body.data.settlements).toHaveLength(1);

    // D9: the expert rates the space; shown on the listing.
    expect((await x.owner.call(wsReview.POST, { params: { tenantSlug: x.slug, id }, body: { rating: 5, body: 'نظيف ومرتب' } })).status).toBe(200);
    const det = await x.owner.call(wsListing.GET, { params: { tenantSlug: x.slug, id: l.id } });
    expect(det.body.data.rating).toMatchObject({ average: 5, count: 1 });
    expect(det.body.data.reviews[0].body).toBe('نظيف ومرتب');
  });

  it('material request during the booking: product sale on approval; QR check-in by the salon', async () => {
    const h = await makeHost();
    const l = await listSpace(h);
    const x = await makeExpert();
    const w = await bookAndPay(x, l.id, at(futureDate(15), '10:00'));
    const product = l.addons.find((a) => a.kind === 'product')!.id;
    const mr = await x.owner.call(wsMaterials.POST, { params: { tenantSlug: x.slug, id: w.id }, body: { addon_id: product, quantity: 1 } });
    expect(mr.status).toBe(200);
    const before = await stockOf(h);
    const ok = await h.owner.call(hostMaterial.POST, { params: { tenantSlug: h.slug, id: w.id, requestId: mr.body.data.id }, body: { approve: true } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await stockOf(h)).on_hand).toBe(before.on_hand - 1);
    expect(ok.body.data.statement.due_from_guest_minor).toBe(Math.round(3600 * 1.15));
    // QR scan by reception requires the token the expert holds; a wrong token is a 404.
    expect((await h.owner.call(hostScan.POST, { params: { tenantSlug: h.slug }, body: { token: 'wsq_' + 'x'.repeat(30) } })).status).toBe(404);
  });

  it('guest cancellation inside the fee window refunds per saved terms and returns products to stock', async () => {
    const h = await makeHost();
    const l = await listSpace(h);
    const x = await makeExpert();
    const product = l.addons.find((a) => a.kind === 'product')!.id;
    // Next 10:00 (Riyadh) at least an hour away: inside the 24h fee window and the listing's hours.
    let start = DateTime.now().setZone('Asia/Riyadh').set({ hour: 10, minute: 0, second: 0, millisecond: 0 });
    if (start.toMillis() < Date.now() + 3_600_000) start = start.plus({ days: 1 });
    const w = await bookAndPay(x, l.id, start.toISO()!, 120, { addons: [{ addon_id: product, quantity: 1 }] });
    const before = await stockOf(h);
    const c = await x.owner.call(wsCancel.POST, { params: { tenantSlug: x.slug, id: w.id }, body: { reason: 'sick' } });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect(c.body.data.status).toBe('cancelled');
    expect((await stockOf(h)).on_hand).toBe(before.on_hand + 1);
    const refunds = await withTenant(h.tenantId, (trx) => trx.selectFrom('refunds as r').innerJoin('payments as p', 'p.id', 'r.payment_id').select(['r.amount_minor', 'r.provider_refund_id']).where('p.workspace_booking_id', '=', w.id).execute());
    expect(refunds).toHaveLength(1);
    expect(refunds[0]!.amount_minor).toBe(w.total_minor - 5000); // fee = 50% of the 10,000 rent
    const done = await x.owner.call(sandboxRefund.POST, { params: { providerRefundId: refunds[0]!.provider_refund_id! }, body: { outcome: 'succeeded' } });
    expect(done.status).toBe(200);
    const after = await x.owner.call(wsBooking.GET, { params: { tenantSlug: x.slug, id: w.id } });
    expect(after.body.data.payment_status).toBe('partially_refunded');
    expect(after.body.data.statement.total_charges_minor).toBe(5000);
    expect(after.body.data.statement.due_from_guest_minor).toBe(0);
  });
});

// ── Isolation ────────────────────────────────────────────────────────────────
describe('tenant isolation', () => {
  it('ID tampering across tenants is denied (listings, bookings, settlements, client appointments)', async () => {
    const h = await makeHost();
    const other = await makeHost();
    const l = await listSpace(h);
    const x = await makeExpert();
    const y = await makeExpert();
    const w = await bookAndPay(x, l.id, at(futureDate(16), '10:00'));
    expect((await other.owner.call(listingOne.GET, { params: { tenantSlug: other.slug, id: l.id } })).status).toBe(404);
    expect((await other.owner.call(listingOne.PATCH, { params: { tenantSlug: other.slug, id: l.id }, body: { price_minor: 1, version: 1 } })).status).toBe(404);
    expect((await other.owner.call(hostBooking.GET, { params: { tenantSlug: other.slug, id: w.id } })).status).toBe(404);
    expect((await other.owner.call(hostSettlement.POST, { params: { tenantSlug: other.slug, id: w.id }, body: {} })).status).toBe(404);
    expect((await y.owner.call(wsBooking.GET, { params: { tenantSlug: y.slug, id: w.id } })).status).toBe(404);
    expect((await y.owner.call(wsCancel.POST, { params: { tenantSlug: y.slug, id: w.id }, body: { reason: 'not mine' } })).status).toBe(404);
    // A guest cannot act as the host on her own booking.
    expect((await x.owner.call(hostBooking.GET, { params: { tenantSlug: x.slug, id: w.id } })).status).toBe(404);
    // Another expert cannot link someone else's client appointment, nor add appointments to someone else's space.
    const theirs = await clientAppointment(x, at(futureDate(17), '15:00'));
    const steal = await request(y, l.id, at(futureDate(17), '14:00'), 180, { link_booking_ids: [theirs] });
    expect(steal.status).toBe(404);
    const tc = await withTenant(x.tenantId, (trx) => trx.selectFrom('bookings').select('tenant_customer_id').where('id', '=', theirs).executeTakeFirstOrThrow());
    const intrude = await y.owner.call(wsAppointments.POST, { params: { tenantSlug: y.slug, id: w.id }, idempotencyKey: true, body: {
      customer_id: tc.tenant_customer_id, items: [{ key: 'a', service_id: x.service, staff_id: x.me, start: iso(at(futureDate(16), '10:30')) }],
    } });
    expect([404, 422]).toContain(intrude.status);
    // RLS: a third tenant sees no workspace rows at all.
    const rows = await withTenant(other.tenantId, (trx) => trx.selectFrom('workspace_bookings').select('id').execute());
    expect(rows).toEqual([]);
    // Writes outside the hosting service are refused even for a party.
    const upd = await withTenant(h.tenantId, (trx) => trx.updateTable('workspace_bookings').set({ total_minor: 1 }).where('id', '=', w.id).executeTakeFirst());
    expect(Number(upd.numUpdatedRows)).toBe(0);
    await expect(withTenant(x.tenantId, (trx) => trx.insertInto('workspace_reviews').values({ workspace_booking_id: w.id, host_tenant_id: h.tenantId, guest_tenant_id: x.tenantId, listing_id: l.id, rating: 5 }).execute())).rejects.toThrow();
    // Lists are scoped.
    expect((await h.owner.call(hostBookings.GET, { params: { tenantSlug: h.slug } })).body.data.map((b: any) => b.id)).toContain(w.id);
    expect((await other.owner.call(hostBookings.GET, { params: { tenantSlug: other.slug } })).body.data).toEqual([]);
    // A salon cannot book spaces (experts only).
    const asSalon = await h.owner.call(wsBookings.POST, { params: { tenantSlug: h.slug }, body: { listing_id: l.id, start: iso(at(futureDate(18), '10:00')), duration_min: 60 }, idempotencyKey: true });
    expect(asSalon.status).toBe(403);
  });
});

// ── Plans ────────────────────────────────────────────────────────────────────
describe('plans', () => {
  it('a downgrade keeps listings, bookings and settlements; only new listings/publishing are blocked', async () => {
    const h = await makeHost();
    const l = await listSpace(h);
    const x = await makeExpert();
    const w = await bookAndPay(x, l.id, at(futureDate(19), '10:00'));
    await withSystem('test: downgrade', async (trx) => {
      const sanaa = await trx.selectFrom('plans').select('id').where('code', '=', 'sanaa').executeTakeFirstOrThrow();
      await trx.updateTable('subscriptions').set({ plan_id: sanaa.id }).where('tenant_id', '=', h.tenantId).execute();
    });
    const list = await h.owner.call(listings.GET, { params: { tenantSlug: h.slug } });
    expect(list.body.data.map((r: any) => r.id)).toContain(l.id);
    expect((await h.owner.call(hostBooking.GET, { params: { tenantSlug: h.slug, id: w.id } })).body.data.status).toBe('confirmed');
    const create = await h.owner.call(listings.POST, { params: { tenantSlug: h.slug }, body: { branch_id: h.branchId, resource_id: h.chair2, code: 'Z9', price_minor: 5000 } });
    expect(create.status).toBe(403);
    // The confirmed booking is honoured: check-in still works on the day.
    const w0 = await hostingTx('test', (trx) => lockBooking(trx, w.id));
    const row = await hostCheck(await h.access(), await actorOf(h.owner), w.id, 'in', new Date(w0.starts_at.getTime() + 60_000));
    expect(['checked_in', 'in_use']).toContain(row.status);
    // The basic plan can still search and book (workspace.book on every plan).
    expect((await x.owner.call(search.GET, { params: { tenantSlug: x.slug }, query: { date: futureDate(20) } })).status).toBe(200);
  });
});

