import { describe, expect, it } from 'vitest';
import { withSystem, withTenant } from '@/server/db/client';
import * as hold from '@/app/api/v1/s/[slug]/bookings/route';
import * as checkout from '@/app/api/v1/s/[slug]/bookings/[id]/checkout/route';
import * as availability from '@/app/api/v1/s/[slug]/availability/route';
import * as visit from '@/app/api/v1/s/[slug]/market-visit/route';
import * as sandboxPay from '@/app/api/v1/sandbox/checkout/[providerPaymentId]/route';
import * as sandboxRefund from '@/app/api/v1/sandbox/refunds/[providerRefundId]/route';
import * as refunds from '@/app/api/v1/t/[tenantSlug]/refunds/route';
import * as onSite from '@/app/api/v1/t/[tenantSlug]/payments/on-site/route';
import * as staffBookings from '@/app/api/v1/t/[tenantSlug]/bookings/route';
import * as variants from '@/app/api/v1/t/[tenantSlug]/services/[id]/variants/route';
import * as addons from '@/app/api/v1/t/[tenantSlug]/services/[id]/addons/route';
import * as packages from '@/app/api/v1/t/[tenantSlug]/packages/route';
import * as pkg from '@/app/api/v1/t/[tenantSlug]/packages/[id]/route';
import * as readinessRoute from '@/app/api/v1/t/[tenantSlug]/onboarding/readiness/route';
import * as accounts from '@/app/api/v1/t/[tenantSlug]/payment-accounts/route';
import * as account from '@/app/api/v1/t/[tenantSlug]/payment-accounts/[id]/route';
import * as reauth from '@/app/api/v1/auth/reauth/route';
import * as cart from '@/app/api/v1/s/[slug]/cart/route';
import * as orderCheckout from '@/app/api/v1/s/[slug]/orders/[id]/checkout/route';
import * as payAtPickup from '@/app/api/v1/s/[slug]/orders/[id]/pay-at-pickup/route';
import * as orderStatus from '@/app/api/v1/t/[tenantSlug]/orders/[id]/status/route';
import * as loyalty from '@/app/api/v1/t/[tenantSlug]/loyalty/route';
import { transition } from '@/server/domains/booking/service';
import { marketplaceFeesFor, reverseMarketplaceCommission } from '@/server/domains/marketplace/attribution';
import { resolveTenantAccess } from '@/server/tenancy/access';
import { resolveSession } from '@/server/auth/service';
import { ORDER_PAYMENT_TTL_MIN, ORDER_PICKUP_HOLD_HOURS } from '@/server/domains/commerce';
import { feeFor } from '@/server/domains/marketplace/rules';
import { at, customer, futureDate, makeSalon, type Salon } from '../helpers/salon';
import { listedBusiness } from '../helpers/market';
import { addToCart, checkout as placeOrder, createProduct, liveShop, stock } from '../helpers/commerce';
import type { TestClient } from '../helpers/http';
import { me } from '../helpers/policy';

const settings = (tenantId: string, patch: Record<string, unknown>) =>
  withSystem('test: settings', (trx) => trx.updateTable('tenant_settings').set(patch).where('tenant_id', '=', tenantId).execute());
const orderCount = (tenantId: string) => withTenant(tenantId, (trx) => trx.selectFrom('orders').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).then((r) => Number(r.n));
const reservations = (tenantId: string, orderId: string) => withTenant(tenantId, (trx) => trx.selectFrom('stock_reservations').select(['status', 'expires_at']).where('order_id', '=', orderId).execute());

async function connectSandbox(owner: TestClient, slug: string) {
  await owner.call(reauth.POST, { body: { password: 'correct horse battery' } });
  const r = await owner.call(accounts.POST, { params: { tenantSlug: slug }, body: { provider: 'sandbox' } });
  expect(r.status).toBe(201);
  return r.body.data.id as string;
}

// ── LUMA-AUDIT-006 / R2: payment eligibility for product orders ────────────────
describe('product orders need a usable payment path (R2)', () => {
  it('no provider and no pay-on-site → no order, no reservation; cart and readiness say so', async () => {
    const { owner, biz, s, p } = await liveShop();
    await settings(biz.tenantId, { allow_pay_on_site: false });
    const prod = await createProduct(owner, biz.slug);
    const c = await customer();
    await addToCart(c, biz.slug, prod.variants[0]!.id, 2);

    const view = await c.call(cart.GET, { params: s });
    expect(view.body.data.payment).toMatchObject({ online: false, pay_at_pickup: false, accepting_orders: false, simulation: false });

    const r = await placeOrder(c, biz.slug, { fulfillment_method: 'pickup' });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('payment_unavailable');
    expect(await orderCount(biz.tenantId)).toBe(0);
    expect(await stock(biz.tenantId, prod.variants[0]!.inventory_item_id)).toMatchObject({ reserved: 0 });

    const ready = await owner.call(readinessRoute.GET, { params: p });
    expect(ready.body.data.items.find((i: { key: string }) => i.key === 'payment_method')).toMatchObject({ ok: false, action_path: `/app/${biz.slug}/settings?tab=payments` });
    expect(ready.body.data.ready).toBe(false);
  });

  it('no provider but pay-on-site → pay-at-pickup order with a pickup-length reservation; staff collect it at the counter', async () => {
    const { owner, biz, s, p } = await liveShop();
    const prod = await createProduct(owner, biz.slug);
    const c = await customer();
    await addToCart(c, biz.slug, prod.variants[0]!.id, 1);
    const view = await c.call(cart.GET, { params: s });
    expect(view.body.data.payment).toMatchObject({ online: false, pay_at_pickup: true, accepting_orders: true, simulation: false });

    // Online is refused server-side even if the browser asks for it.
    const online = await placeOrder(c, biz.slug, { payment_choice: 'online' });
    expect(online.status).toBe(422);
    expect(online.body.error.code).toBe('payment_option_not_allowed');

    const before = Date.now();
    const r = await placeOrder(c, biz.slug, {});
    expect(r.status).toBe(201);
    expect(r.body.data.payment_choice).toBe('on_site');
    const exp = Date.parse(r.body.data.expires_at);
    expect(exp - before).toBeGreaterThan((ORDER_PICKUP_HOLD_HOURS * 60 - 1) * 60_000);
    const res = await reservations(biz.tenantId, r.body.data.id);
    expect(res).toHaveLength(1);
    expect(res[0]!.status).toBe('active');
    expect(res[0]!.expires_at.getTime()).toBe(exp);

    // Paying online stays impossible: a clear 409 that points to pay at pickup; the order is kept.
    const pay = await c.call(orderCheckout.POST, { params: { slug: biz.slug, id: r.body.data.id }, body: {}, idempotencyKey: true });
    expect(pay.status).toBe(409);
    expect(pay.body.error.code).toBe('online_payment_unavailable');
    expect((await reservations(biz.tenantId, r.body.data.id))[0]!.status).toBe('active');

    // Counter: cash with a reference → paid; the reservation becomes a sale.
    const col = await owner.call(onSite.POST, { params: p, body: { order_id: r.body.data.id, amount_minor: 10000, method: 'cash', reference: 'PK-1' }, idempotencyKey: true });
    expect(col.status).toBe(201);
    const o = await withTenant(biz.tenantId, (trx) => trx.selectFrom('orders').select(['status', 'paid_minor']).where('id', '=', r.body.data.id).executeTakeFirstOrThrow());
    expect(o).toEqual({ status: 'paid', paid_minor: 10000 });
    expect((await reservations(biz.tenantId, r.body.data.id))[0]!.status).toBe('consumed');
  });

  it('provider disappears before payment: pay-at-pickup offered when allowed, otherwise the order is cancelled and stock released', async () => {
    const { owner, biz, p } = await liveShop();
    const acct = await connectSandbox(owner, biz.slug);
    const prod = await createProduct(owner, biz.slug);
    const item = prod.variants[0]!.inventory_item_id;

    // A: online order, provider disconnected, pay-on-site still on → switch to pickup.
    const a = await customer();
    await addToCart(a, biz.slug, prod.variants[0]!.id, 1);
    const ra = await placeOrder(a, biz.slug, {});
    expect(ra.body.data.payment_choice).toBe('online');
    expect(Date.parse(ra.body.data.expires_at) - Date.now()).toBeLessThanOrEqual(ORDER_PAYMENT_TTL_MIN * 60_000);
    expect((await owner.call(account.DELETE, { params: { ...p, id: acct }, method: 'DELETE' })).status).toBe(200);
    const pa = await a.call(orderCheckout.POST, { params: { slug: biz.slug, id: ra.body.data.id }, body: {}, idempotencyKey: true });
    expect(pa.status).toBe(409);
    expect(pa.body.error.code).toBe('online_payment_unavailable');
    expect(pa.body.error.details.pay_at_pickup_available).toBe(true);
    const sw = await a.call(payAtPickup.POST, { params: { slug: biz.slug, id: ra.body.data.id }, body: {} });
    expect(sw.status).toBe(200);
    expect(sw.body.data.payment_choice).toBe('on_site');
    expect(Date.parse(sw.body.data.expires_at) - Date.now()).toBeGreaterThan((ORDER_PICKUP_HOLD_HOURS * 60 - 1) * 60_000);

    // B: online order, provider gone AND pay-on-site switched off → clear error, order cancelled, reservation released.
    const acct2 = await connectSandbox(owner, biz.slug);
    const b = await customer();
    await addToCart(b, biz.slug, prod.variants[0]!.id, 2);
    const rb = await placeOrder(b, biz.slug, { payment_choice: 'online' });
    expect(rb.status).toBe(201);
    expect((await stock(biz.tenantId, item)).reserved).toBe(3);
    await owner.call(account.DELETE, { params: { ...p, id: acct2 }, method: 'DELETE' });
    await settings(biz.tenantId, { allow_pay_on_site: false });
    const pb = await b.call(orderCheckout.POST, { params: { slug: biz.slug, id: rb.body.data.id }, body: {}, idempotencyKey: true });
    expect(pb.status).toBe(422);
    expect(pb.body.error.code).toBe('payment_unavailable');
    expect(pb.body.error.details.order_cancelled).toBe(true);
    const ob = await withTenant(biz.tenantId, (trx) => trx.selectFrom('orders').select(['status', 'cancel_reason']).where('id', '=', rb.body.data.id).executeTakeFirstOrThrow());
    expect(ob).toEqual({ status: 'cancelled', cancel_reason: 'payment_unavailable' });
    expect((await reservations(biz.tenantId, rb.body.data.id)).map((x) => x.status)).toEqual(['released']);
    expect((await stock(biz.tenantId, item)).reserved).toBe(1); // only A's pickup reservation remains
  });

  it('a customer restriction (full payment required) removes pay at pickup', async () => {
    const { owner, biz } = await liveShop();
    const prod = await createProduct(owner, biz.slug);
    const c = await customer();
    await addToCart(c, biz.slug, prod.variants[0]!.id, 1);
    const tc = await placeOrder(c, biz.slug, {}); // creates the customer relationship
    expect(tc.status).toBe(201);
    const reviewer = await me(owner);
    await withSystem('test: tenant decision', async (trx) => {
      const cust = await trx.selectFrom('orders').select('tenant_customer_id').where('id', '=', tc.body.data.id).executeTakeFirstOrThrow();
      await trx.insertInto('policy_decisions').values({
        tenant_id: biz.tenantId, scope: 'tenant', tenant_customer_id: cust.tenant_customer_id, action: 'require_full_payment', status: 'active',
        reason: 'repeated no-show', customer_explanation_ar: 'مطلوب الدفع المسبق', customer_explanation_en: 'Prepayment required', reviewer_id: reviewer.id,
      }).execute();
    });
    await addToCart(c, biz.slug, prod.variants[0]!.id, 1);
    const r = await placeOrder(c, biz.slug, {});
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('payment_unavailable');
  });
});

// ── R6: loyalty on product orders ──────────────────────────────────────────────
describe('loyalty on paid product orders (R6)', () => {
  it('earns once at collection on the paid amount, reverses proportionally on refund, never twice', async () => {
    const { owner, biz, p } = await liveShop();
    await owner.call(reauth.POST, { body: { password: 'correct horse battery' } });
    const lp = await owner.call(loyalty.GET, { params: p });
    const up = await owner.call(loyalty.PUT, { params: p, method: 'PUT', body: { is_enabled: true, points_per_currency_unit: 1, points_expiry_days: 365, tiers: [], reverse_on_refund: true, version: lp.body.data.program.version } });
    expect(up.status).toBe(200);
    const prod = await createProduct(owner, biz.slug, {}, { price_minor: 25050 });
    const c = await customer();
    await addToCart(c, biz.slug, prod.variants[0]!.id, 1);
    const r = await placeOrder(c, biz.slug, {});
    const id = r.body.data.id as string;
    const pay = await owner.call(onSite.POST, { params: p, body: { order_id: id, amount_minor: 25050, method: 'cash', reference: 'LY-1' }, idempotencyKey: true });
    expect(pay.status).toBe(201);
    const points = () => withTenant(biz.tenantId, (trx) => trx.selectFrom('points_entries').select(['kind', 'delta', 'ref_type']).orderBy('created_at').execute());
    expect(await points()).toEqual([]); // paid but not collected: nothing yet

    expect((await owner.call(orderStatus.POST, { params: { ...p, id }, body: { to: 'ready' } })).status).toBe(200);
    expect((await owner.call(orderStatus.POST, { params: { ...p, id }, body: { to: 'collected' } })).status).toBe(200);
    expect(await points()).toEqual([{ kind: 'earn', delta: 250, ref_type: 'order' }]);
    // Collecting again is refused; no second earn.
    expect((await owner.call(orderStatus.POST, { params: { ...p, id }, body: { to: 'collected' } })).status).toBe(409);

    // Two partial refunds: 100.20 → 100 pts, then the rest (150.30) → capped at the 150 still un-reversed.
    const r1 = await owner.call(refunds.POST, { params: p, body: { payment_id: pay.body.data.payment_id, amount_minor: 10020, reason: 'damaged item' }, idempotencyKey: true });
    expect(r1.status).toBeLessThan(300);
    const r2 = await owner.call(refunds.POST, { params: p, body: { payment_id: pay.body.data.payment_id, amount_minor: 15030, reason: 'rest of the order' }, idempotencyKey: true });
    expect(r2.status).toBeLessThan(300);
    const all = await points();
    expect(all.map((e) => [e.kind, e.delta])).toEqual([['earn', 250], ['reverse', -100], ['reverse', -150]]);
    const bal = await withTenant(biz.tenantId, (trx) => trx.selectFrom('loyalty_accounts').select('balance').executeTakeFirstOrThrow());
    expect(bal.balance).toBe(0);
  });
});

// ── LUMA-AUDIT-020 / R1: commission reversal ────────────────────────────────────
const sid = () => `mkt${Math.random().toString(36).slice(2, 14)}`;
async function marketplaceBooking(s: Salon, start: string) {
  const session = sid();
  const c = await customer();
  await c.call(visit.POST, { params: { slug: s.slug }, headers: { 'x-luma-session': session }, body: {} });
  const h = await c.call(hold.POST, { params: { slug: s.slug }, headers: { 'x-luma-session': session }, body: { items: [{ key: 'x', service_id: s.services.haircut, staff_id: s.staff.sara, start }] }, idempotencyKey: true });
  const id = h.body.data.booking_id as string;
  const co = await c.call(checkout.POST, { params: { slug: s.slug, id }, headers: { 'x-luma-session': session }, body: { option: 'full' }, idempotencyKey: true });
  expect(co.status).toBe(201);
  const p = await withTenant(s.tenantId, (trx) => trx.selectFrom('payments').select(['id', 'provider_payment_id']).where('booking_id', '=', id).executeTakeFirstOrThrow());
  await c.call(sandboxPay.POST, { params: { providerPaymentId: p.provider_payment_id! }, body: { outcome: 'captured' } });
  return { id, paymentId: p.id, c };
}
async function complete(s: Salon, id: string) {
  const user = await resolveSession(s.owner.cookies.get('luma_session'));
  const access = await resolveTenantAccess(user!, s.slug);
  const b = await withTenant(s.tenantId, (trx) => trx.selectFrom('bookings').select('starts_at').where('id', '=', id).executeTakeFirstOrThrow());
  const now = new Date(b.starts_at.getTime() + 60_000);
  const actor = { kind: 'staff' as const, access, audit: { userId: user!.userId, kind: 'user' as const } };
  await transition(s.tenantId, id, 'check_in', actor, { now });
  await transition(s.tenantId, id, 'complete', actor, { now });
}
/** Staff refund on the sandbox payment, then the provider's success webhook (optionally delivered twice). */
async function refund(s: Salon, c: TestClient, paymentId: string, amount: number, opts: { deliverTwice?: boolean } = {}) {
  const r = await s.owner.call(refunds.POST, { params: { tenantSlug: s.slug }, body: { payment_id: paymentId, amount_minor: amount, reason: 'service issue' }, idempotencyKey: true });
  expect(r.status).toBeLessThan(300);
  const rf = await withTenant(s.tenantId, (trx) => trx.selectFrom('refunds').select(['id', 'provider_refund_id']).where('payment_id', '=', paymentId).orderBy('created_at', 'desc').executeTakeFirstOrThrow());
  const ok = await c.call(sandboxRefund.POST, { params: { providerRefundId: rf.provider_refund_id! }, body: { outcome: 'succeeded' } });
  expect(ok.status).toBe(200);
  if (opts.deliverTwice) await c.call(sandboxRefund.POST, { params: { providerRefundId: rf.provider_refund_id! }, body: { outcome: 'succeeded' } });
  return rf.id;
}
const reversals = (s: Salon) => withTenant(s.tenantId, (trx) => trx.selectFrom('marketplace_commission_reversals').select(['refund_minor', 'cumulative_refund_minor', 'fee_reversed_minor']).orderBy('created_at').execute());

describe('marketplace commission reversal on refund after completion (R1)', () => {
  it('partial refunds reverse proportionally (half-up), the full remainder reverses the rest, repeats never double-reverse', async () => {
    const s = await listedBusiness({ commissionBp: 1500 });
    const { id, paymentId, c } = await marketplaceBooking(s, at(futureDate(4), '10:00'));
    await complete(s, id);
    const [line] = await withTenant(s.tenantId, (trx) => trx.selectFrom('marketplace_commissions').selectAll().execute());
    expect(line).toMatchObject({ base_minor: 10000, fee_minor: 1500 });

    const first = await refund(s, c, paymentId, 3333, { deliverTwice: true });
    // remaining fee on 66.67 at 15 % = floor((6667×1500 + 5000)/10000) = 1000 → reversed 500.
    expect(await reversals(s)).toEqual([{ refund_minor: 3333, cumulative_refund_minor: 3333, fee_reversed_minor: 1500 - feeFor(6667, 1500) }]);
    expect(feeFor(6667, 1500)).toBe(1000);
    // Calling the hook again for the same refund (e.g. a replayed event) is a no-op.
    expect(await withTenant(s.tenantId, (trx) => reverseMarketplaceCommission(trx, s.tenantId, first))).toEqual({ reversed: false });

    await refund(s, c, paymentId, 6667);
    const rows = await reversals(s);
    expect(rows.map((r) => r.fee_reversed_minor)).toEqual([500, 1000]);
    expect(rows.reduce((a, r) => a + r.fee_reversed_minor, 0)).toBe(line!.fee_minor); // full refund → full reversal, never more

    const today = new Date().toISOString().slice(0, 10);
    const fees = await marketplaceFeesFor(s.tenantId, { from: today, to: futureDate(10) });
    expect(fees.reversed_fee_minor).toBe(1500);
    expect(fees.net_fee_minor).toBe(fees.fee_minor - 1500);
  });

  it('a single full refund reverses the whole fee', async () => {
    const s = await listedBusiness({ commissionBp: 1000 });
    const { id, paymentId, c } = await marketplaceBooking(s, at(futureDate(4), '12:00'));
    await complete(s, id);
    await refund(s, c, paymentId, 10000);
    expect(await reversals(s)).toEqual([{ refund_minor: 10000, cumulative_refund_minor: 10000, fee_reversed_minor: 1000 }]);
  });

  it('out of order: a refund that succeeds before completion is excluded from the base and never reversed again', async () => {
    const s = await listedBusiness({ commissionBp: 1000 });
    const { id, paymentId, c } = await marketplaceBooking(s, at(futureDate(4), '14:00'));
    await refund(s, c, paymentId, 4000); // refund event first…
    await complete(s, id); // …then the completion hook
    const [line] = await withTenant(s.tenantId, (trx) => trx.selectFrom('marketplace_commissions').selectAll().execute());
    expect(line).toMatchObject({ base_minor: 6000, fee_minor: 600 });
    expect(await reversals(s)).toEqual([]);
    // A later refund of the rest reverses exactly the remaining line.
    await refund(s, c, paymentId, 6000);
    expect((await reversals(s)).map((r) => r.fee_reversed_minor)).toEqual([600]);
  });
});

// ── LUMA-AUDIT-018: variants and add-ons online ─────────────────────────────────
describe('service variants and add-ons chosen online (018)', () => {
  it('a variant + two add-ons: slot length and total are re-quoted server-side and match a dashboard booking', async () => {
    const s = await makeSalon();
    const p = { tenantSlug: s.slug, id: s.services.color };
    const v = await s.owner.call(variants.POST, { params: p, body: { name_ar: 'شعر طويل', price_minor: 40000, duration_min: 120 } });
    expect(v.status).toBe(201);
    const a1 = await s.owner.call(addons.POST, { params: p, body: { name_ar: 'علاج', price_minor: 5000, duration_min: 15 } });
    const a2 = await s.owner.call(addons.POST, { params: p, body: { name_ar: 'تجفيف', price_minor: 2500, duration_min: 15 } });
    const opts = { variant_id: v.body.data.id, addon_ids: [a1.body.data.id, a2.body.data.id] };
    const d = futureDate(5);
    const c = await customer();

    const av = await c.call(availability.POST, { params: { slug: s.slug }, body: { items: [{ key: 'x', service_id: s.services.color, staff_id: s.staff.sara, ...opts }], from: d, to: d } });
    expect(av.status).toBe(200);
    const first = av.body.data.days[d][0];
    expect(first.items[0]).toMatchObject({ price_minor: 47500, duration_min: 150 });
    expect(Date.parse(first.items[0].end) - Date.parse(first.items[0].start)).toBe(150 * 60_000);

    const h = await c.call(hold.POST, { params: { slug: s.slug }, body: { items: [{ key: 'x', service_id: s.services.color, staff_id: s.staff.sara, start: at(d, '10:00'), ...opts }] }, idempotencyKey: true });
    expect(h.status).toBe(201);
    const row = (bid: string) => withTenant(s.tenantId, (trx) => trx.selectFrom('booking_items as i').innerJoin('bookings as b', 'b.id', 'i.booking_id')
      .select(['i.variant_id', 'i.duration_min', 'i.line_total_minor', 'i.starts_at', 'i.ends_at', 'b.total_minor', 'b.tenant_customer_id']).where('b.id', '=', bid).executeTakeFirstOrThrow());
    const online = await row(h.body.data.booking_id);
    expect(online).toMatchObject({ variant_id: v.body.data.id, duration_min: 150, line_total_minor: 47500, total_minor: 47500 });
    expect(online.ends_at.getTime() - online.starts_at.getTime()).toBe(150 * 60_000);

    // The dashboard quote for the same selection (staff booking) prices and times it identically.
    const staff = await s.owner.call(staffBookings.POST, { params: { tenantSlug: s.slug }, body: { customer_id: online.tenant_customer_id, mode: 'confirm_on_site', items: [{ key: 'y', service_id: s.services.color, staff_id: s.staff.sara, start: at(futureDate(6), '10:00'), ...opts }] }, idempotencyKey: true });
    expect(staff.status).toBe(201);
    const desk = await row(staff.body.data.booking_id);
    expect([desk.duration_min, desk.line_total_minor, desk.total_minor]).toEqual([online.duration_min, online.line_total_minor, online.total_minor]);

    // Never trusts the browser: an add-on of another service is rejected.
    const other = await s.owner.call(addons.POST, { params: { tenantSlug: s.slug, id: s.services.haircut }, body: { name_ar: 'غسيل', price_minor: 1000, duration_min: 10 } });
    const bad = await c.call(hold.POST, { params: { slug: s.slug }, body: { items: [{ key: 'x', service_id: s.services.color, staff_id: s.staff.sara, start: at(d, '14:00'), addon_ids: [other.body.data.id] }] }, idempotencyKey: true });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('invalid_addon');
  });

  it('multi-service booking with different qualified specialists still works with options', async () => {
    const s = await makeSalon();
    const v = await s.owner.call(variants.POST, { params: { tenantSlug: s.slug, id: s.services.color }, body: { name_ar: 'قصير', price_minor: 25000, duration_min: 60 } });
    const d = futureDate(5);
    const c = await customer();
    const items = [
      { key: 'a', service_id: s.services.color, staff_id: s.staff.sara, variant_id: v.body.data.id },
      { key: 'b', service_id: s.services.nails, staff_id: s.staff.huda },
    ];
    const av = await c.call(availability.POST, { params: { slug: s.slug }, body: { items, from: d, to: d } });
    const opt = av.body.data.days[d][0];
    expect(opt.items.map((i: { staff_id: string }) => i.staff_id)).toEqual([s.staff.sara, s.staff.huda]);
    const h = await c.call(hold.POST, { params: { slug: s.slug }, body: { items: opt.items.map((i: { key: string; start: string }) => ({ ...items.find((x) => x.key === i.key)!, start: i.start })) }, idempotencyKey: true });
    expect(h.status).toBe(201);
    const b = await withTenant(s.tenantId, (trx) => trx.selectFrom('bookings').select('total_minor').where('id', '=', h.body.data.booking_id).executeTakeFirstOrThrow());
    expect(b.total_minor).toBe(25000 + 8000);
  });
});

// ── LUMA-AUDIT-033 / R7: package editing ──────────────────────────────────────
describe('package editing (R7)', () => {
  it('edits name, price and contents in place (same id for offer blocks); stale edits conflict; existing bookings keep their terms', async () => {
    const s = await makeSalon();
    const p = { tenantSlug: s.slug };
    const created = await s.owner.call(packages.POST, { params: p, body: { name_ar: 'باقة العروس', price_minor: 35000, service_ids: [s.services.haircut, s.services.color] } });
    expect(created.status).toBe(201);
    const id = created.body.data.id as string;
    // A booking made before the edit (prices snapshot on its items).
    const c = await customer();
    const h = await c.call(hold.POST, { params: { slug: s.slug }, body: { items: [{ key: 'x', service_id: s.services.haircut, staff_id: s.staff.sara, start: at(futureDate(4), '10:00') }] }, idempotencyKey: true });
    const before = await withTenant(s.tenantId, (trx) => trx.selectFrom('bookings').select('total_minor').where('id', '=', h.body.data.booking_id).executeTakeFirstOrThrow());

    const list = await s.owner.call(packages.GET, { params: p });
    const cur = list.body.data.find((x: { id: string }) => x.id === id);
    const body = { name_ar: 'باقة العروس الذهبية', name_en: 'Gold bridal', price_minor: 39000, service_ids: [s.services.color, s.services.haircut, s.services.nails], is_active: true, is_visible: true, updated_at: cur.updated_at };
    const ed = await s.owner.call(pkg.PATCH, { params: { ...p, id }, method: 'PATCH', body });
    expect(ed.status).toBe(200);
    expect(ed.body.data).toMatchObject({ id, name_ar: 'باقة العروس الذهبية', price_minor: 39000, service_ids: [s.services.color, s.services.haircut, s.services.nails] });
    // Second editor with the old version → 409.
    const stale = await s.owner.call(pkg.PATCH, { params: { ...p, id }, method: 'PATCH', body: { ...body, price_minor: 1 } });
    expect(stale.status).toBe(409);
    // Unknown/archived services are refused.
    const again = (await s.owner.call(packages.GET, { params: p })).body.data.find((x: { id: string }) => x.id === id);
    const bad = await s.owner.call(pkg.PATCH, { params: { ...p, id }, method: 'PATCH', body: { ...body, service_ids: [s.services.color, '00000000-0000-4000-8000-000000000000'], updated_at: again.updated_at } });
    expect(bad.status).toBe(422);

    const after = await withTenant(s.tenantId, (trx) => trx.selectFrom('bookings').select('total_minor').where('id', '=', h.body.data.booking_id).executeTakeFirstOrThrow());
    expect(after.total_minor).toBe(before.total_minor);
    const audit = await withTenant(s.tenantId, (trx) => trx.selectFrom('audit_logs').select('action').where('action', '=', 'package.updated').execute());
    expect(audit).toHaveLength(1);
  });
});
