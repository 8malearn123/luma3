import { describe, expect, it } from 'vitest';
import { withTenant } from '@/server/db/client';
import { cancelOrder } from '@/server/domains/commerce';
import { signup } from '../helpers/factory';
import { addToCart, checkout, createProduct, liveShop, stock } from '../helpers/commerce';
import * as accounts from '@/app/api/v1/t/[tenantSlug]/payment-accounts/route';
import * as reauth from '@/app/api/v1/auth/reauth/route';
import * as orderCheckout from '@/app/api/v1/s/[slug]/orders/[id]/checkout/route';
import * as sandboxPay from '@/app/api/v1/sandbox/checkout/[providerPaymentId]/route';

async function shopWithSandbox() {
  const shop = await liveShop();
  await shop.owner.call(reauth.POST, { body: { password: 'correct horse battery' } });
  const acct = await shop.owner.call(accounts.POST, { params: shop.p, body: { provider: 'sandbox' } });
  expect(acct.status).toBe(201);
  return shop;
}

const order = (tenantId: string, id: string) => withTenant(tenantId, (trx) => trx.selectFrom('orders').select(['status', 'paid_minor', 'total_minor']).where('id', '=', id).executeTakeFirstOrThrow());
const payment = (tenantId: string, id: string) => withTenant(tenantId, (trx) => trx.selectFrom('payments').select(['provider_payment_id', 'needs_reconciliation']).where('id', '=', id).executeTakeFirstOrThrow());

describe('order payments (commerce ↔ payments wiring)', () => {
  it('captured payment marks the order paid, turns the reservation into a sale and posts product revenue', async () => {
    const { owner, biz, s } = await shopWithSandbox();
    const v = (await createProduct(owner, biz.slug, {}, { initial_stock: 3 })).variants[0]!;
    const c = await signup('Buyer');
    expect((await addToCart(c, s.slug, v.id, 2)).status).toBe(201);
    const o = await checkout(c, s.slug);
    expect(o.status).toBe(201);
    const co = await c.call(orderCheckout.POST, { params: { slug: s.slug, id: o.body.data.id }, body: {}, idempotencyKey: true });
    expect(co.status).toBe(201);
    const pp = await payment(biz.tenantId, co.body.data.payment.id);
    const done = await c.call(sandboxPay.POST, { params: { providerPaymentId: pp.provider_payment_id! }, body: { outcome: 'captured' } });
    expect(done.body.data.webhook).toBe('processed');
    const row = await order(biz.tenantId, o.body.data.id);
    expect(row.status).toBe('paid');
    expect(row.paid_minor).toBe(row.total_minor);
    expect(await stock(biz.tenantId, v.inventory_item_id)).toEqual({ on_hand: 1, reserved: 0 });
    const rev = await withTenant(biz.tenantId, (trx) => trx.selectFrom('financial_entries').select('credit_minor').where('account', '=', 'product_revenue').execute());
    expect(rev.reduce((a, e) => a + e.credit_minor, 0)).toBeGreaterThan(0);
  });

  it('a capture arriving after the order was cancelled is flagged and refunded, never kept', async () => {
    const { owner, biz, s } = await shopWithSandbox();
    const v = (await createProduct(owner, biz.slug, {}, { initial_stock: 2 })).variants[0]!;
    const c = await signup('Late payer');
    await addToCart(c, s.slug, v.id, 1);
    const o = await checkout(c, s.slug);
    const co = await c.call(orderCheckout.POST, { params: { slug: s.slug, id: o.body.data.id }, body: {}, idempotencyKey: true });
    expect(co.status).toBe(201);
    await withTenant(biz.tenantId, (trx) => cancelOrder(trx, biz.tenantId, o.body.data.id, 'test', null));
    const pp = await payment(biz.tenantId, co.body.data.payment.id);
    await c.call(sandboxPay.POST, { params: { providerPaymentId: pp.provider_payment_id! }, body: { outcome: 'captured' } });
    expect((await order(biz.tenantId, o.body.data.id)).status).toBe('cancelled');
    expect((await payment(biz.tenantId, co.body.data.payment.id)).needs_reconciliation).toBe(true);
    const refunds = await withTenant(biz.tenantId, (trx) => trx.selectFrom('refunds').select(['amount_minor', 'reason']).where('payment_id', '=', co.body.data.payment.id).execute());
    expect(refunds).toHaveLength(1);
    expect(refunds[0]!.reason).toBe('captured_after_order_cancelled');
    expect(await stock(biz.tenantId, v.inventory_item_id)).toEqual({ on_hand: 2, reserved: 0 });
  });
});

describe('server-side conversions link to the storefront session', () => {
  it('a paid order records order_paid once, under the session that started checkout', async () => {
    const { owner, biz, s } = await shopWithSandbox();
    const v = (await createProduct(owner, biz.slug, {}, { initial_stock: 2 })).variants[0]!;
    const c = await signup('Tracked buyer');
    await addToCart(c, s.slug, v.id, 1);
    const sid = 'sessAbc12345';
    const o = await c.call((await import('@/app/api/v1/s/[slug]/orders/route')).POST, { params: { slug: s.slug }, body: {}, idempotencyKey: true, headers: { 'x-luma-session': sid } });
    expect(o.status).toBe(201);
    const co = await c.call(orderCheckout.POST, { params: { slug: s.slug, id: o.body.data.id }, body: {}, idempotencyKey: true });
    const pp = await payment(biz.tenantId, co.body.data.payment.id);
    await c.call(sandboxPay.POST, { params: { providerPaymentId: pp.provider_payment_id! }, body: { outcome: 'captured' } });
    const ev = await withTenant(biz.tenantId, (trx) => trx.selectFrom('analytics_events').select(['session_id', 'entity_id']).where('type', '=', 'order_paid').execute());
    expect(ev).toEqual([{ session_id: sid, entity_id: o.body.data.id }]);
  });
});
