import { describe, expect, it } from 'vitest';
import { withTenant } from '@/server/db/client';
import { cancelOrder, expireStaleOrders, markOrderPaid } from '@/server/domains/commerce';
import { signup } from '../helpers/factory';
import { TestClient } from '../helpers/http';
import { addMember, addToCart, checkout, createProduct, liveShop, movements, stock } from '../helpers/commerce';
import * as cart from '@/app/api/v1/s/[slug]/cart/route';
import * as cartItem from '@/app/api/v1/s/[slug]/cart/items/[variantId]/route';
import * as ack from '@/app/api/v1/s/[slug]/cart/acknowledge/route';
import * as productOne from '@/app/api/v1/t/[tenantSlug]/products/[id]/route';
import * as products from '@/app/api/v1/t/[tenantSlug]/products/route';
import * as orders from '@/app/api/v1/t/[tenantSlug]/orders/route';
import * as orderOne from '@/app/api/v1/t/[tenantSlug]/orders/[id]/route';
import * as orderStatus from '@/app/api/v1/t/[tenantSlug]/orders/[id]/status/route';
import * as orderCancel from '@/app/api/v1/t/[tenantSlug]/orders/[id]/cancel/route';
import * as returns from '@/app/api/v1/t/[tenantSlug]/orders/[id]/returns/route';
import * as returnOne from '@/app/api/v1/t/[tenantSlug]/orders/[id]/returns/[returnId]/route';
import * as customerOrder from '@/app/api/v1/s/[slug]/orders/[id]/route';

describe('order creation & stock', () => {
  it('one unit, two concurrent checkouts: exactly one succeeds, stock never negative, loser gets out_of_stock', async () => {
    const { owner, biz, s } = await liveShop();
    const prod = await createProduct(owner, biz.slug, {}, { initial_stock: 1 });
    const v = prod.variants[0]!;
    const [a, b] = [await signup('A'), await signup('B')];
    expect((await addToCart(a, s.slug, v.id)).status).toBe(201);
    expect((await addToCart(b, s.slug, v.id)).status).toBe(201);
    const [ra, rb] = await Promise.all([checkout(a, s.slug), checkout(b, s.slug)]);
    const statuses = [ra.status, rb.status].sort();
    expect(statuses).toEqual([201, 409]);
    const loser = ra.status === 409 ? ra : rb;
    expect(loser.body.error.code).toBe('out_of_stock');
    const st = await stock(biz.tenantId, v.inventory_item_id);
    expect(st).toEqual({ on_hand: 1, reserved: 1 });
    const mv = await movements(biz.tenantId, v.inventory_item_id);
    expect(mv.filter((m) => m.kind === 'reservation')).toHaveLength(1);
  });

  it('idempotent checkout: the same Idempotency-Key returns the same order; a required key is enforced', async () => {
    const { owner, biz, s } = await liveShop();
    const prod = await createProduct(owner, biz.slug);
    const c = await signup('Customer');
    await addToCart(c, s.slug, prod.variants[0]!.id, 2);
    expect((await c.call((await import('@/app/api/v1/s/[slug]/orders/route')).POST, { params: s, body: {} })).status).toBe(422);
    const key = `test-key-${Date.now()}`;
    const r1 = await checkout(c, s.slug, {}, key);
    const r2 = await checkout(c, s.slug, {}, key);
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(r2.body.data.id).toBe(r1.body.data.id);
    expect(r2.body.data.replayed).toBe(true);
    expect(r1.body.data.number).toMatch(/^ORD-\d{6}$/);
    expect(r1.body.data.checkout_path).toBe(`/s/${s.slug}/checkout/order/${r1.body.data.id}`);
    const n = await withTenant(biz.tenantId, (trx) => trx.selectFrom('orders').select('id').execute());
    expect(n).toHaveLength(1);
    // Customer sees her own order; another customer cannot.
    expect((await c.call(customerOrder.GET, { params: { ...s, id: r1.body.data.id } })).status).toBe(200);
    expect((await (await signup('Other')).call(customerOrder.GET, { params: { ...s, id: r1.body.data.id } })).status).toBe(404);
  });

  it('price change after adding: cart flags it, checkout requires acknowledgement and uses the server price; client prices ignored', async () => {
    const { owner, biz, p, s } = await liveShop();
    const prod = await createProduct(owner, biz.slug);
    const v = prod.variants[0]!;
    const c = await signup('Customer');
    // A browser-supplied price is stripped and never used.
    expect((await c.call((await import('@/app/api/v1/s/[slug]/cart/items/route')).POST, { params: s, body: { variant_id: v.id, quantity: 1, unit_price_minor: 1, added_unit_price_minor: 1 } })).status).toBe(201);
    const up = await owner.call(productOne.PATCH, { params: { ...p, id: prod.id }, body: { version: prod.version, variants: [{ id: v.id, price_minor: 15000 }] } });
    expect(up.status).toBe(200);
    const view = await c.call(cart.GET, { params: s });
    expect(view.body.data.has_price_changes).toBe(true);
    expect(view.body.data.items[0]).toMatchObject({ added_unit_price_minor: 10000, unit_price_minor: 15000, price_changed: true });
    expect(view.body.data.items[0]).not.toHaveProperty('unit_cost_minor', expect.anything());
    const blocked = await checkout(c, s.slug, { total_minor: 1 });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('prices_changed');
    expect((await c.call(ack.POST, { params: s, body: {} })).body.data.has_price_changes).toBe(false);
    const ok = await checkout(c, s.slug, { total_minor: 1 });
    expect(ok.status).toBe(201);
    expect(ok.body.data.total_minor).toBe(15000);
    const items = await withTenant(biz.tenantId, (trx) => trx.selectFrom('order_items').select(['unit_price_minor', 'name_ar']).execute());
    expect(items).toEqual([{ unit_price_minor: 15000, name_ar: 'شامبو' }]);
  });

  it('rejects bad quantities, merges duplicate lines, enforces max_per_order and availability', async () => {
    const { owner, biz, s } = await liveShop();
    const prod = await createProduct(owner, biz.slug, { max_per_order: 3 }, { initial_stock: 10 });
    const v = prod.variants[0]!;
    const c = await signup('Customer');
    for (const q of [0, -1, 1000, 1.5]) expect((await addToCart(c, s.slug, v.id, q)).status).toBe(422);
    expect((await addToCart(c, s.slug, v.id, 2)).status).toBe(201);
    const merged = await addToCart(c, s.slug, v.id, 1);
    expect(merged.body.data.items).toHaveLength(1);
    expect(merged.body.data.items[0].quantity).toBe(3);
    const over = await addToCart(c, s.slug, v.id, 1);
    expect(over.status).toBe(422);
    expect(over.body.error.code).toBe('max_per_order_exceeded');
    expect((await c.call(cartItem.PATCH, { params: { ...s, variantId: v.id }, body: { quantity: 4 } })).body.error.code).toBe('max_per_order_exceeded');
    // Out of stock cannot be added.
    const p2 = await createProduct(owner, biz.slug, { name_ar: 'نفد' }, { initial_stock: 0 });
    const oos = await addToCart(c, s.slug, p2.variants[0]!.id, 1);
    expect(oos.status).toBe(409);
    expect(oos.body.error.code).toBe('out_of_stock');
  });

  it('anonymous cart survives sign-in and merges into the customer cart', async () => {
    const { owner, biz, s } = await liveShop();
    const prod = await createProduct(owner, biz.slug);
    const anon = new TestClient();
    expect((await addToCart(anon, s.slug, prod.variants[0]!.id, 2)).status).toBe(201);
    expect(anon.cookies.get('luma_cart')).toBeTruthy();
    expect((await checkout(anon, s.slug)).status).toBe(401);
    const user = await signup('Later');
    user.cookies.set('luma_cart', anon.cookies.get('luma_cart')!);
    const view = await user.call(cart.GET, { params: s });
    expect(view.body.data.items[0].quantity).toBe(2);
    expect((await checkout(user, s.slug)).status).toBe(201);
  });

  it('cross-tenant: another business variant cannot be added to a cart; unpublished shops are hidden', async () => {
    const a = await liveShop();
    const b = await liveShop();
    const prodB = await createProduct(b.owner, b.biz.slug);
    const c = await signup('C');
    const r = await addToCart(c, a.s.slug, prodB.variants[0]!.id);
    expect(r.status).toBe(404);
    // Owner A cannot read B's product through her own workspace.
    expect((await a.owner.call(productOne.GET, { params: { tenantSlug: a.biz.slug, id: prodB.id } })).status).toBe(404);
    // Onboarding (not live) shop: same 404.
    const { createBusinessFor } = await import('../helpers/factory');
    const hidden = await createBusinessFor(await signup());
    expect((await c.call(cart.GET, { params: { slug: hidden.slug } })).status).toBe(404);
  });
});

describe('payment, expiry and cancellation are exactly-once', () => {
  async function pendingOrder(qty = 2) {
    const shop = await liveShop();
    const prod = await createProduct(shop.owner, shop.biz.slug);
    const v = prod.variants[0]!;
    const c = await signup('Customer');
    await addToCart(c, shop.s.slug, v.id, qty);
    const r = await checkout(c, shop.s.slug);
    expect(r.status).toBe(201);
    return { ...shop, v, c, orderId: r.body.data.id as string, total: r.body.data.total_minor as number };
  }

  it('expiry run twice releases stock once', async () => {
    const o = await pendingOrder();
    expect(await stock(o.biz.tenantId, o.v.inventory_item_id)).toEqual({ on_hand: 5, reserved: 2 });
    await withTenant(o.biz.tenantId, (trx) => trx.updateTable('orders').set({ expires_at: new Date(Date.now() - 1000) }).where('id', '=', o.orderId).execute());
    await expireStaleOrders();
    await expireStaleOrders();
    expect(await stock(o.biz.tenantId, o.v.inventory_item_id)).toEqual({ on_hand: 5, reserved: 0 });
    const mv = await movements(o.biz.tenantId, o.v.inventory_item_id);
    expect(mv.filter((m) => m.kind === 'release')).toHaveLength(1);
    const order = await withTenant(o.biz.tenantId, (trx) => trx.selectFrom('orders').select(['status', 'cancel_reason']).where('id', '=', o.orderId).executeTakeFirstOrThrow());
    expect(order).toEqual({ status: 'cancelled', cancel_reason: 'payment_expired' });
    // A late payment is not applied silently.
    expect(await withTenant(o.biz.tenantId, (trx) => markOrderPaid(trx, o.biz.tenantId, o.orderId, { paymentId: crypto.randomUUID(), amountMinor: o.total }))).toEqual({ changed: false, reason: 'order_cancelled' });
  });

  it('failed payment cancel called twice releases once', async () => {
    const o = await pendingOrder();
    const r1 = await withTenant(o.biz.tenantId, (trx) => cancelOrder(trx, o.biz.tenantId, o.orderId, 'payment_failed', null));
    const r2 = await withTenant(o.biz.tenantId, (trx) => cancelOrder(trx, o.biz.tenantId, o.orderId, 'payment_failed', null));
    expect(r1).toEqual({ released: true });
    expect(r2).toEqual({ released: false });
    const mv = await movements(o.biz.tenantId, o.v.inventory_item_id);
    expect(mv.filter((m) => m.kind === 'release')).toHaveLength(1);
    expect(await stock(o.biz.tenantId, o.v.inventory_item_id)).toEqual({ on_hand: 5, reserved: 0 });
  });

  it('markOrderPaid twice → one sale; fulfillment to collected does not deduct again; collected cannot be cancelled', async () => {
    const o = await pendingOrder();
    const pay = { paymentId: crypto.randomUUID(), amountMinor: o.total };
    expect(await withTenant(o.biz.tenantId, (trx) => markOrderPaid(trx, o.biz.tenantId, o.orderId, pay))).toEqual({ changed: true });
    expect((await withTenant(o.biz.tenantId, (trx) => markOrderPaid(trx, o.biz.tenantId, o.orderId, pay))).changed).toBe(false);
    expect(await stock(o.biz.tenantId, o.v.inventory_item_id)).toEqual({ on_hand: 3, reserved: 0 });
    for (const to of ['preparing', 'ready', 'collected']) {
      const r = await o.owner.call(orderStatus.POST, { params: { ...o.p, id: o.orderId }, body: { to } });
      expect(r.status).toBe(200);
    }
    expect(await stock(o.biz.tenantId, o.v.inventory_item_id)).toEqual({ on_hand: 3, reserved: 0 });
    const mv = await movements(o.biz.tenantId, o.v.inventory_item_id);
    expect(mv.map((m) => m.kind)).toEqual(['receipt', 'reservation', 'sale']);
    const back = await o.owner.call(orderStatus.POST, { params: { ...o.p, id: o.orderId }, body: { to: 'preparing' } });
    expect(back.status).toBe(409);
    const cancel = await o.owner.call(orderCancel.POST, { params: { ...o.p, id: o.orderId }, body: { reason: 'changed mind' } });
    expect(cancel.status).toBe(409);
    expect(cancel.body.error.code).toBe('order_collected');
    // Return with restock → 'return' movement on approval, exactly once.
    const detail = await o.owner.call(orderOne.GET, { params: { ...o.p, id: o.orderId } });
    expect(detail.body.data.events.map((e: any) => e.kind)).toEqual(['created', 'paid', 'status_changed', 'status_changed', 'status_changed']);
    const itemId = detail.body.data.items[0].id;
    const ret = await o.owner.call(returns.POST, { params: { ...o.p, id: o.orderId }, body: { reason: 'damaged box', restock: true, items: [{ order_item_id: itemId, quantity: 1 }] } });
    expect(ret.status).toBe(201);
    const tooMany = await o.owner.call(returns.POST, { params: { ...o.p, id: o.orderId }, body: { reason: 'again', items: [{ order_item_id: itemId, quantity: 2 }] } });
    expect(tooMany.body.error.code).toBe('return_quantity_exceeded');
    expect((await o.owner.call(returnOne.PATCH, { params: { ...o.p, id: o.orderId, returnId: ret.body.data.id }, body: { decision: 'approved' } })).status).toBe(200);
    expect((await o.owner.call(returnOne.PATCH, { params: { ...o.p, id: o.orderId, returnId: ret.body.data.id }, body: { decision: 'approved' } })).status).toBe(409);
    expect(await stock(o.biz.tenantId, o.v.inventory_item_id)).toEqual({ on_hand: 4, reserved: 0 });
  });

  it('cancelling a paid, uncollected order puts the goods back on the shelf', async () => {
    const o = await pendingOrder(1);
    await withTenant(o.biz.tenantId, (trx) => markOrderPaid(trx, o.biz.tenantId, o.orderId, { paymentId: crypto.randomUUID(), amountMinor: o.total }));
    const r = await o.owner.call(orderCancel.POST, { params: { ...o.p, id: o.orderId }, body: { reason: 'customer request' } });
    expect(r.status).toBe(200);
    expect(r.body.data.status).toBe('cancelled');
    expect(await stock(o.biz.tenantId, o.v.inventory_item_id)).toEqual({ on_hand: 5, reserved: 0 });
  });
});

describe('order & product permissions', () => {
  it('receptionist manages orders without seeing costs; specialist cannot access orders', async () => {
    const { owner, biz, p, s } = await liveShop();
    const prod = await createProduct(owner, biz.slug, {}, { cost_minor: 4000 });
    expect(prod.variants[0]).toHaveProperty('cost_minor', 4000);
    const c = await signup('C');
    await addToCart(c, s.slug, prod.variants[0]!.id);
    const o = await checkout(c, s.slug);
    const recep = await addMember(owner, biz.slug, 'receptionist');
    const list = await recep.call(orders.GET, { params: p });
    expect(list.status).toBe(200);
    expect(list.body.data.items).toHaveLength(1);
    const detail = await recep.call(orderOne.GET, { params: { ...p, id: o.body.data.id } });
    expect(detail.status).toBe(200);
    expect(detail.body.data.items[0]).not.toHaveProperty('unit_cost_minor');
    expect((await owner.call(orderOne.GET, { params: { ...p, id: o.body.data.id } })).body.data.items[0].unit_cost_minor).toBe(4000);
    // Receptionist can view products (orders.manage) but never their costs, and cannot create products.
    const rp = await recep.call(productOne.GET, { params: { ...p, id: prod.id } });
    expect(rp.status).toBe(200);
    expect(rp.body.data.variants[0]).not.toHaveProperty('cost_minor');
    expect((await recep.call(products.POST, { params: p, body: { name_ar: 'x', variants: [{ price_minor: 1 }] } })).status).toBe(403);
    expect((await recep.call(orderCancel.POST, { params: { ...p, id: o.body.data.id }, body: { reason: 'customer called' } })).status).toBe(200);

    const spec = await addMember(owner, biz.slug, 'specialist');
    expect((await spec.call(orders.GET, { params: p })).status).toBe(403);
    expect((await spec.call(orderOne.GET, { params: { ...p, id: o.body.data.id } })).status).toBe(403);
  });

  it('a manager without costs.view cannot set costs; plan limit limit.products is enforced on direct API calls', async () => {
    const { owner, biz, p } = await liveShop('sanaa');
    const mgr = await addMember(owner, biz.slug, 'manager');
    // Manager lacks catalog.edit by default.
    expect((await mgr.call(products.POST, { params: p, body: { name_ar: 'x', variants: [{ price_minor: 1 }] } })).status).toBe(403);
    const made = await Promise.all(Array.from({ length: 30 }, (_, i) => owner.call(products.POST, { params: p, body: { name_ar: `منتج ${i}`, variants: [{ price_minor: 100 + i }] } })));
    expect(made.every((r) => r.status === 201)).toBe(true);
    const over = await owner.call(products.POST, { params: p, body: { name_ar: 'زائد', variants: [{ price_minor: 100 }] } });
    expect(over.status).toBe(403);
    expect(over.body.error.code).toBe('plan_limit_reached');
    const list = await owner.call(products.GET, { params: p, query: { limit: '10', sort: 'price', dir: 'desc' } });
    expect(list.body.data.total).toBe(30);
    expect(list.body.data.items).toHaveLength(10);
    expect(list.body.data.items[0].price_minor).toBe(129);
  });
});
