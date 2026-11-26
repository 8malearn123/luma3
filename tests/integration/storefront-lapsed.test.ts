import { describe, expect, it } from 'vitest';
import { makeSalon, customer, futureDate, at } from '../helpers/salon';
import { setSubscription } from '../helpers/platform';
import { liveShop, createProduct, addToCart } from '../helpers/commerce';
import { signup } from '../helpers/factory';
import { storefrontSelling } from '@/server/domains/storefront-public';
import * as hold from '@/app/api/v1/s/[slug]/bookings/route';
import * as ownBooking from '@/app/api/v1/s/[slug]/bookings/[id]/route';
import * as availability from '@/app/api/v1/s/[slug]/availability/route';
import * as orders from '@/app/api/v1/s/[slug]/orders/route';

/**
 * R4 / LUMA-AUDIT-012: a lapsed subscription keeps the storefront taking new
 * bookings/orders only inside its grace window; afterwards new ones are refused
 * (409 storefront_unavailable) while the store stays readable and existing
 * bookings are untouched.
 */
const item = (service_id: string, staff_id: string, start: string) => ({ key: 'a', service_id, staff_id, start });

describe('storefront after the subscription lapses', () => {
  it('bookings: allowed during grace, refused after it; existing bookings stay readable', async () => {
    const s = await makeSalon();
    const c = await customer();
    const d = futureDate(4);

    // past_due, still inside the grace window → still sells.
    await setSubscription(s.tenantId, { status: 'past_due', grace_until: new Date(Date.now() + 3 * 86_400_000) });
    expect(await storefrontSelling(s.tenantId)).toBe(true);
    const inGrace = await c.call(hold.POST, { params: { slug: s.slug }, body: { items: [item(s.services.haircut, s.staff.sara, at(d, '10:00'))] }, idempotencyKey: true });
    expect(inGrace.status).toBe(201);
    const existing = inGrace.body.data.booking_id as string;

    // Grace over → no new bookings.
    await setSubscription(s.tenantId, { status: 'past_due', grace_until: new Date(Date.now() - 60_000) });
    expect(await storefrontSelling(s.tenantId)).toBe(false);
    const after = await c.call(hold.POST, { params: { slug: s.slug }, body: { items: [item(s.services.haircut, s.staff.huda, at(d, '12:00'))] }, idempotencyKey: true });
    expect(after.status).toBe(409);
    expect(after.body.error.code).toBe('storefront_unavailable');

    // Expired (the lifecycle job's next state) → still refused.
    await setSubscription(s.tenantId, { status: 'expired' });
    expect((await c.call(hold.POST, { params: { slug: s.slug }, body: { items: [item(s.services.nails, s.staff.huda, at(d, '14:00'))] }, idempotencyKey: true })).status).toBe(409);

    // The store and the customer's existing booking remain readable.
    expect((await c.call(availability.POST, { params: { slug: s.slug }, body: { from: d, to: d, items: [{ key: 'a', service_id: s.services.haircut }] } })).status).toBe(200);
    const mine = await c.call(ownBooking.GET, { params: { slug: s.slug, id: existing } });
    expect(mine.status).toBe(200);
    expect(mine.body.data.id).toBe(existing);

    // Reactivated → sells again.
    await setSubscription(s.tenantId, { status: 'active', grace_until: null });
    expect((await c.call(hold.POST, { params: { slug: s.slug }, body: { items: [item(s.services.haircut, s.staff.huda, at(d, '15:00'))] }, idempotencyKey: true })).status).toBe(201);
  });

  it('orders: no new order after the grace window', async () => {
    const shop = await liveShop();
    const product = await createProduct(shop.owner, shop.biz.slug);
    const buyer = await signup('Buyer');
    await addToCart(buyer, shop.biz.slug, product.variants[0]!.id, 1);
    await setSubscription(shop.biz.tenantId, { status: 'past_due', grace_until: new Date(Date.now() - 60_000) });
    const r = await buyer.call(orders.POST, { params: { slug: shop.biz.slug }, body: {}, idempotencyKey: true });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('storefront_unavailable');

    await setSubscription(shop.biz.tenantId, { status: 'past_due', grace_until: new Date(Date.now() + 86_400_000) });
    const ok = await buyer.call(orders.POST, { params: { slug: shop.biz.slug }, body: {}, idempotencyKey: true });
    expect(ok.body?.error?.code).not.toBe('storefront_unavailable');
  });
});
