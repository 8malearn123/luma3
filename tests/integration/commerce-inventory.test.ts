import { describe, expect, it } from 'vitest';
import { withTenant } from '@/server/db/client';
import { capacityEstimate, consumeMaterialsForBookingItem, redeemCoupon, releaseCouponRedemption, validateCoupon } from '@/server/domains/commerce';
import { signup } from '../helpers/factory';
import { addMember, addToCart, checkout, createProduct, liveShop, movements, stock } from '../helpers/commerce';
import * as items from '@/app/api/v1/t/[tenantSlug]/inventory/items/route';
import * as itemOne from '@/app/api/v1/t/[tenantSlug]/inventory/items/[id]/route';
import * as itemMoves from '@/app/api/v1/t/[tenantSlug]/inventory/items/[id]/movements/route';
import * as recipe from '@/app/api/v1/t/[tenantSlug]/inventory/recipes/[serviceId]/route';
import * as recipes from '@/app/api/v1/t/[tenantSlug]/inventory/recipes/route';
import * as capacity from '@/app/api/v1/t/[tenantSlug]/inventory/capacity/route';
import * as consumption from '@/app/api/v1/t/[tenantSlug]/inventory/consumption/route';
import * as services from '@/app/api/v1/t/[tenantSlug]/services/route';
import * as staff from '@/app/api/v1/t/[tenantSlug]/staff/route';
import * as coupons from '@/app/api/v1/t/[tenantSlug]/coupons/route';
import * as couponOne from '@/app/api/v1/t/[tenantSlug]/coupons/[id]/route';
import * as preview from '@/app/api/v1/s/[slug]/coupons/validate/route';
import { convertUnits } from '@/shared/units';

async function setupMaterials() {
  const shop = await liveShop('wahaj');
  const svc = await shop.owner.call(services.POST, { params: shop.p, body: { name_ar: 'صبغة', price_minor: 30000, duration_min: 90 } });
  expect(svc.status).toBe(201);
  const dye = await shop.owner.call(items.POST, { params: shop.p, body: { name: 'صبغة شعر', unit: 'ml', initial_quantity: 500, low_stock_threshold: 100, cost_per_unit_minor: 30 } });
  expect(dye.status).toBe(201);
  const gloves = await shop.owner.call(items.POST, { params: shop.p, body: { name: 'قفازات', unit: 'piece', initial_quantity: 3 } });
  return { ...shop, serviceId: svc.body.data.id as string, dye: dye.body.data, gloves: gloves.body.data };
}

async function bookingItem(tenantId: string, branchId: string, serviceId: string, staffId: string) {
  return withTenant(tenantId, async (trx) => {
    const tc = await trx.insertInto('tenant_customers').values({ tenant_id: tenantId, display_name: 'Walk-in', source: 'walk_in' }).returning('id').executeTakeFirstOrThrow();
    const start = new Date(Date.now() + 86_400_000), end = new Date(start.getTime() + 90 * 60_000);
    const b = await trx.insertInto('bookings').values({
      tenant_id: tenantId, branch_id: branchId, number: `BKG-T${Math.floor(Math.random() * 1e9)}`, tenant_customer_id: tc.id, status: 'completed', source: 'dashboard',
      starts_at: start, ends_at: end, timezone: 'Asia/Riyadh', subtotal_minor: 30000, total_minor: 30000,
    }).returning('id').executeTakeFirstOrThrow();
    const bi = await trx.insertInto('booking_items').values({
      tenant_id: tenantId, booking_id: b.id, sequence: 1, service_id: serviceId, staff_id: staffId, starts_at: start, ends_at: end,
      staff_name: 'S', duration_min: 90, unit_price_minor: 30000, line_total_minor: 30000,
    }).returning('id').executeTakeFirstOrThrow();
    return bi.id;
  });
}

describe('unit conversions', () => {
  it('converts within a dimension and rejects incompatible units', () => {
    expect(convertUnits(1.5, 'l', 'ml')).toBe(1500);
    expect(convertUnits(250, 'g', 'kg')).toBe(0.25);
    expect(convertUnits(2, 'piece', 'piece')).toBe(2);
    expect(convertUnits(1, 'ml', 'g')).toBeNull();
    expect(convertUnits(1, 'piece', 'ml')).toBeNull();
  });
});

describe('operational inventory', () => {
  it('capacity estimate: insufficient_data without a recipe; N with method when data exists; incompatible recipe units rejected', async () => {
    const m = await setupMaterials();
    const none = await withTenant(m.biz.tenantId, (trx) => capacityEstimate(trx, m.biz.tenantId, m.serviceId));
    expect(none).toMatchObject({ status: 'insufficient_data', reasons: ['no_recipe'] });
    const bad = await m.owner.call(recipe.PUT, { params: { ...m.p, serviceId: m.serviceId }, body: { lines: [{ inventory_item_id: m.dye.id, quantity: 60, unit: 'g' }] } });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('incompatible_units');
    // 0.06 l = 60 ml per booking; 500 ml → 8 bookings; gloves 1 piece → 3 bookings (limiting).
    const ok = await m.owner.call(recipe.PUT, { params: { ...m.p, serviceId: m.serviceId }, body: { lines: [{ inventory_item_id: m.dye.id, quantity: 0.06, unit: 'l' }, { inventory_item_id: m.gloves.id, quantity: 1, unit: 'piece' }] } });
    expect(ok.status).toBe(200);
    const cap = await m.owner.call(capacity.GET, { params: m.p });
    const est = cap.body.data.find((s: any) => s.id === m.serviceId).estimate;
    expect(est.status).toBe('ok');
    expect(est.bookings).toBe(3);
    expect(est.limitingItemId).toBe(m.gloves.id);
    expect(est.method).toMatch(/floor/);
    expect(est.lines.find((l: any) => l.inventoryItemId === m.dye.id)).toMatchObject({ perBooking: 60, bookings: 8 });
    const listed = await m.owner.call(recipes.GET, { params: m.p });
    expect(listed.body.data.find((s: any) => s.id === m.serviceId).lines.find((l: any) => l.inventory_item_id === m.dye.id).item_quantity).toBe(60);
    // A material that never had stock recorded is unreliable data → no invented number.
    const empty = await m.owner.call(items.POST, { params: m.p, body: { name: 'أوكسجين', unit: 'ml' } });
    await m.owner.call(recipe.PUT, { params: { ...m.p, serviceId: m.serviceId }, body: { lines: [{ inventory_item_id: empty.body.data.id, quantity: 10, unit: 'ml' }] } });
    const est2 = await withTenant(m.biz.tenantId, (trx) => capacityEstimate(trx, m.biz.tenantId, m.serviceId));
    expect(est2.status).toBe('insufficient_data');
  });

  it('consumes materials exactly once per booking item; shortages never go negative and are flagged', async () => {
    const m = await setupMaterials();
    await m.owner.call(recipe.PUT, { params: { ...m.p, serviceId: m.serviceId }, body: { lines: [{ inventory_item_id: m.dye.id, quantity: 60, unit: 'ml' }, { inventory_item_id: m.gloves.id, quantity: 2, unit: 'piece' }] } });
    const st = await m.owner.call(staff.POST, { params: m.p, body: { display_name: 'Specialist' } });
    const bi1 = await bookingItem(m.biz.tenantId, m.biz.branchId, m.serviceId, st.body.data.id);
    const r1 = await withTenant(m.biz.tenantId, (trx) => consumeMaterialsForBookingItem(trx, m.biz.tenantId, bi1, null));
    expect(r1.skipped).toBeNull();
    expect(r1.consumed).toEqual(expect.arrayContaining([{ inventoryItemId: m.dye.id, quantity: 60, unit: 'ml' }, { inventoryItemId: m.gloves.id, quantity: 2, unit: 'piece' }]));
    const again = await m.owner.call(consumption.POST, { params: m.p, body: { booking_item_id: bi1 } });
    expect(again.body.data.skipped).toBe('already_consumed');
    expect(await stock(m.biz.tenantId, m.dye.id)).toEqual({ on_hand: 440, reserved: 0 });
    expect((await movements(m.biz.tenantId, m.dye.id)).filter((x) => x.kind === 'consumption')).toHaveLength(1);
    // Second visit: only 1 glove left → consume 1, flag shortage of 1, never negative.
    const bi2 = await bookingItem(m.biz.tenantId, m.biz.branchId, m.serviceId, st.body.data.id);
    const r2 = await withTenant(m.biz.tenantId, (trx) => consumeMaterialsForBookingItem(trx, m.biz.tenantId, bi2, null));
    expect(r2.shortages).toEqual([{ inventoryItemId: m.gloves.id, required: 2, consumed: 1, unit: 'piece' }]);
    expect(await stock(m.biz.tenantId, m.gloves.id)).toEqual({ on_hand: 0, reserved: 0 });
    const notes = await withTenant(m.biz.tenantId, (trx) => trx.selectFrom('notifications').select('kind').where('kind', 'in', ['inventory.consumption_shortage', 'inventory.low_stock']).execute());
    expect(notes.map((n) => n.kind)).toContain('inventory.consumption_shortage');
    // Actual usage differed → manual adjustment linked to the visit, with a mandatory reason.
    const noReason = await m.owner.call(itemMoves.POST, { params: { ...m.p, id: m.dye.id }, body: { kind: 'adjustment', quantity: -20 } });
    expect(noReason.status).toBe(422);
    const adj = await m.owner.call(itemMoves.POST, { params: { ...m.p, id: m.dye.id }, body: { kind: 'adjustment', quantity: -20, reason: 'used more than recipe', booking_item_id: bi2 } });
    expect(adj.status).toBe(201);
    expect(adj.body.data.on_hand).toBe(360);
    // No recipe → skipped, nothing consumed.
    const svc2 = await m.owner.call(services.POST, { params: m.p, body: { name_ar: 'قص', price_minor: 5000, duration_min: 30 } });
    const bi3 = await bookingItem(m.biz.tenantId, m.biz.branchId, svc2.body.data.id, st.body.data.id);
    expect((await withTenant(m.biz.tenantId, (trx) => consumeMaterialsForBookingItem(trx, m.biz.tenantId, bi3, null))).skipped).toBe('no_recipe');
  });

  it('receipts convert units, adjustments cannot go below zero, low-stock alerts dedupe per day, history pages', async () => {
    const m = await setupMaterials();
    const rec = await m.owner.call(itemMoves.POST, { params: { ...m.p, id: m.dye.id }, body: { kind: 'receipt', quantity: 1, unit: 'l' } });
    expect(rec.body.data.on_hand).toBe(1500);
    expect((await m.owner.call(itemMoves.POST, { params: { ...m.p, id: m.dye.id }, body: { kind: 'receipt', quantity: 1, unit: 'kg' } })).body.error.code).toBe('incompatible_units');
    const neg = await m.owner.call(itemMoves.POST, { params: { ...m.p, id: m.dye.id }, body: { kind: 'adjustment', quantity: -2000, reason: 'count' } });
    expect(neg.status).toBe(409);
    expect(neg.body.error.code).toBe('insufficient_stock');
    await m.owner.call(itemMoves.POST, { params: { ...m.p, id: m.dye.id }, body: { kind: 'adjustment', quantity: -1450, reason: 'spill' } });
    await m.owner.call(itemMoves.POST, { params: { ...m.p, id: m.dye.id }, body: { kind: 'adjustment', quantity: -10, reason: 'spill again' } });
    const low = await withTenant(m.biz.tenantId, (trx) => trx.selectFrom('notifications').select('dedupe_key').where('kind', '=', 'inventory.low_stock').execute());
    expect(low).toHaveLength(1);
    const lowList = await m.owner.call(items.GET, { params: m.p, query: { low: '1' } });
    expect(lowList.body.data.items.map((i: any) => i.id)).toEqual([m.dye.id]);
    const h1 = await m.owner.call(itemMoves.GET, { params: { ...m.p, id: m.dye.id }, query: { limit: '2' } });
    expect(h1.body.data.items).toHaveLength(2);
    const h2 = await m.owner.call(itemMoves.GET, { params: { ...m.p, id: m.dye.id }, query: { limit: '2', cursor: h1.body.data.next_cursor } });
    expect(h2.body.data.items.map((x: any) => x.kind)).toEqual(['receipt', 'receipt']);
  });

  it('receptionist sees inventory without costs and cannot adjust; plan without inventory feature is gated', async () => {
    const m = await setupMaterials();
    const recep = await addMember(m.owner, m.biz.slug, 'receptionist');
    const view = await recep.call(itemOne.GET, { params: { ...m.p, id: m.dye.id } });
    expect(view.status).toBe(200);
    expect(view.body.data).not.toHaveProperty('cost_per_unit_minor');
    expect((await m.owner.call(itemOne.GET, { params: { ...m.p, id: m.dye.id } })).body.data.cost_per_unit_minor).toBe(30);
    expect((await recep.call(itemMoves.POST, { params: { ...m.p, id: m.dye.id }, body: { kind: 'receipt', quantity: 1 } })).status).toBe(403);
    const sanaa = await liveShop('sanaa');
    const r = await sanaa.owner.call(items.GET, { params: sanaa.p });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('plan_feature_unavailable');
    // Retail stock is still manageable from products on that plan.
    const prod = await createProduct(sanaa.owner, sanaa.biz.slug);
    const rec = await sanaa.owner.call(itemMoves.POST, { params: { ...sanaa.p, id: prod.variants[0]!.inventory_item_id }, body: { kind: 'receipt', quantity: 3, reason: 'delivery' } });
    expect(rec.status).toBe(201);
    expect(rec.body.data.on_hand).toBe(8);
  });
});

describe('coupons', () => {
  async function shopWithCoupon(body: Record<string, unknown>) {
    const shop = await liveShop();
    const r = await shop.owner.call(coupons.POST, { params: shop.p, body: { code: `C${Math.random().toString(36).slice(2, 8)}`, kind: 'percent', value: 1000, ...body } });
    expect(r.status).toBe(201);
    expect(r.body.data.source).toBe('manual');
    return { ...shop, coupon: r.body.data };
  }
  async function customer(tenantId: string) {
    return withTenant(tenantId, async (trx) => (await trx.insertInto('tenant_customers').values({ tenant_id: tenantId, display_name: 'X', source: 'dashboard' }).returning('id').executeTakeFirstOrThrow()).id);
  }

  it('validates window, min subtotal and applicability', async () => {
    const future = await shopWithCoupon({ starts_at: new Date(Date.now() + 86_400_000).toISOString() });
    const tc = await customer(future.biz.tenantId);
    await expect(withTenant(future.biz.tenantId, (trx) => validateCoupon(trx, future.biz.tenantId, future.coupon.code, { tenantCustomerId: tc, subtotalMinor: 10000, appliesTo: 'products' }))).rejects.toMatchObject({ code: 'coupon_not_started' });
    const past = await shopWithCoupon({ ends_at: new Date(Date.now() - 1000).toISOString() });
    const tc2 = await customer(past.biz.tenantId);
    await expect(withTenant(past.biz.tenantId, (trx) => validateCoupon(trx, past.biz.tenantId, past.coupon.code, { tenantCustomerId: tc2, subtotalMinor: 10000, appliesTo: 'products' }))).rejects.toMatchObject({ code: 'coupon_expired' });
    const min = await shopWithCoupon({ min_subtotal_minor: 20000, applies_to: 'products' });
    const tc3 = await customer(min.biz.tenantId);
    const v = (sub: number, appliesTo: 'products' | 'services' = 'products') => withTenant(min.biz.tenantId, (trx) => validateCoupon(trx, min.biz.tenantId, min.coupon.code.toLowerCase(), { tenantCustomerId: tc3, subtotalMinor: sub, appliesTo }));
    await expect(v(19999)).rejects.toMatchObject({ code: 'coupon_min_subtotal' });
    await expect(v(30000, 'services')).rejects.toMatchObject({ code: 'coupon_not_applicable' });
    expect(await v(30000)).toMatchObject({ discountMinor: 3000 });
    await expect(withTenant(min.biz.tenantId, (trx) => validateCoupon(trx, min.biz.tenantId, 'NOPE-123', { tenantCustomerId: tc3, subtotalMinor: 30000, appliesTo: 'products' }))).rejects.toMatchObject({ code: 'coupon_invalid' });
  });

  it('per-customer limit, release frees the slot, and max redemptions hold under concurrency', async () => {
    const shop = await shopWithCoupon({ kind: 'fixed', value: 500, max_redemptions: 3, per_customer_limit: 1 });
    const t = shop.biz.tenantId;
    const prod = await createProduct(shop.owner, shop.biz.slug, {}, { initial_stock: 50 });
    // Through checkout: discount applied server-side, second use by the same customer refused.
    const c = await signup('Cust');
    await addToCart(c, shop.s.slug, prod.variants[0]!.id);
    const pv = await c.call(preview.POST, { params: shop.s, body: { code: shop.coupon.code } });
    expect(pv.body.data).toMatchObject({ discount_minor: 500, total_minor: 9500 });
    const o1 = await checkout(c, shop.s.slug, { coupon_code: shop.coupon.code });
    expect(o1.status).toBe(201);
    expect(o1.body.data).toMatchObject({ discount_minor: 500, total_minor: 9500 });
    await addToCart(c, shop.s.slug, prod.variants[0]!.id);
    const o2 = await checkout(c, shop.s.slug, { coupon_code: shop.coupon.code });
    expect(o2.status).toBe(409);
    expect(o2.body.error.code).toBe('coupon_customer_limit');
    // Cancelling releases the redemption exactly once → the customer can use it again.
    const { cancelOrder } = await import('@/server/domains/commerce');
    await withTenant(t, (trx) => cancelOrder(trx, t, o1.body.data.id, 'payment_failed', null));
    expect(await withTenant(t, (trx) => releaseCouponRedemption(trx, t, { orderId: o1.body.data.id }))).toEqual({ released: 0 });
    expect((await checkout(c, shop.s.slug, { coupon_code: shop.coupon.code })).status).toBe(201);

    // 6 different customers race for the 2 remaining redemptions.
    const customers = await Promise.all(Array.from({ length: 6 }, () => customer(t)));
    const results = await Promise.allSettled(customers.map((tc) => withTenant(t, async (trx) => {
      const order = await trx.insertInto('orders').values({
        tenant_id: t, branch_id: shop.biz.branchId, number: `T-${tc.slice(0, 8)}`, tenant_customer_id: tc, status: 'pending_payment', subtotal_minor: 10000, total_minor: 9500,
      }).returning('id').executeTakeFirstOrThrow();
      return redeemCoupon(trx, t, shop.coupon.id, { tenantCustomerId: tc, orderId: order.id, discountMinor: 500 });
    })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    expect(results.filter((r) => r.status === 'rejected').every((r) => (r as PromiseRejectedResult).reason.code === 'coupon_exhausted')).toBe(true);
    const row = await withTenant(t, (trx) => trx.selectFrom('coupons').select('redemptions_count').where('id', '=', shop.coupon.id).executeTakeFirstOrThrow());
    expect(row.redemptions_count).toBe(3);
    // Limit cannot drop below usage; deactivation (not deletion) is how coupons end.
    expect((await shop.owner.call(couponOne.PATCH, { params: { ...shop.p, id: shop.coupon.id }, body: { max_redemptions: 1 } })).status).toBe(422);
    expect((await shop.owner.call(couponOne.PATCH, { params: { ...shop.p, id: shop.coupon.id }, body: { is_active: false } })).body.data.is_active).toBe(false);
    // Receptionist (no catalog.edit) cannot manage coupons.
    const recep = await addMember(shop.owner, shop.biz.slug, 'receptionist');
    expect((await recep.call(coupons.GET, { params: shop.p })).status).toBe(403);
  });
});
