import { describe, expect, it } from 'vitest';
import { at, customer, futureDate, makeSalon, type Salon } from '../helpers/salon';
import { withSystem, withTenant } from '@/server/db/client';
import * as hold from '@/app/api/v1/s/[slug]/bookings/route';
import * as checkout from '@/app/api/v1/s/[slug]/bookings/[id]/checkout/route';
import * as onSite from '@/app/api/v1/t/[tenantSlug]/payments/on-site/route';
import * as refunds from '@/app/api/v1/t/[tenantSlug]/refunds/route';
import * as loyalty from '@/app/api/v1/t/[tenantSlug]/loyalty/route';
import * as rewards from '@/app/api/v1/t/[tenantSlug]/loyalty/rewards/route';
import * as myLoyalty from '@/app/api/v1/s/[slug]/loyalty/route';
import * as redeem from '@/app/api/v1/s/[slug]/loyalty/redeem/route';
import * as gifts from '@/app/api/v1/t/[tenantSlug]/gift-cards/route';
import * as giftBalance from '@/app/api/v1/s/[slug]/gift-cards/balance/route';
import * as giftRedeem from '@/app/api/v1/s/[slug]/bookings/[id]/gift-card/route';
import * as plans from '@/app/api/v1/t/[tenantSlug]/membership-plans/route';
import * as sell from '@/app/api/v1/t/[tenantSlug]/memberships/route';
import * as applyMembership from '@/app/api/v1/s/[slug]/bookings/[id]/apply-membership/route';
import * as accountCancel from '@/app/api/v1/account/bookings/[id]/cancel/route';
import { transition } from '@/server/domains/booking/service';
import { resolveTenantAccess } from '@/server/tenancy/access';
import { resolveSession } from '@/server/auth/service';

async function bookAndPayOnSite(s: Salon, start: string) {
  const c = await customer();
  const h = await c.call(hold.POST, { params: { slug: s.slug }, body: { items: [{ key: 'x', service_id: s.services.haircut, staff_id: s.staff.sara, start }] }, idempotencyKey: true });
  await c.call(checkout.POST, { params: { slug: s.slug, id: h.body.data.booking_id }, body: { option: 'on_site' }, idempotencyKey: true });
  return { c, id: h.body.data.booking_id as string };
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

describe('loyalty', () => {
  it('earns once on a paid completed visit, redeems safely under concurrency, reverses on refund', async () => {
    const s = await makeSalon();
    const lp = await s.owner.call(loyalty.GET, { params: { tenantSlug: s.slug } });
    await s.owner.call(loyalty.PUT, { params: { tenantSlug: s.slug }, body: { is_enabled: true, points_per_currency_unit: 1, points_expiry_days: 365, tiers: [], reverse_on_refund: true, version: lp.body.data.program.version } });
    const rw = await s.owner.call(rewards.POST, { params: { tenantSlug: s.slug }, body: { name_ar: 'خصم', points_cost: 60, kind: 'fixed_discount', value: 2000 } });
    const { c, id } = await bookAndPayOnSite(s, at(futureDate(3), '10:00'));
    const pay = await s.owner.call(onSite.POST, { params: { tenantSlug: s.slug }, body: { booking_id: id, amount_minor: 10000, method: 'cash', reference: 'L-1' }, idempotencyKey: true });
    await complete(s, id);
    const mine = await c.call(myLoyalty.GET, { params: { slug: s.slug } });
    expect(mine.body.data.balance).toBe(100);
    // Two concurrent redemptions of 60 points from a balance of 100: only one succeeds.
    const [r1, r2] = await Promise.all([
      c.call(redeem.POST, { params: { slug: s.slug }, body: { reward_id: rw.body.data.id }, idempotencyKey: true }),
      c.call(redeem.POST, { params: { slug: s.slug }, body: { reward_id: rw.body.data.id }, idempotencyKey: true }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([201, 422]);
    // Refund half → reverse 50 points but never below zero (balance is 40).
    await s.owner.call(refunds.POST, { params: { tenantSlug: s.slug }, body: { payment_id: pay.body.data.payment_id, amount_minor: 5000, reason: 'partial refund' }, idempotencyKey: true });
    const after = await c.call(myLoyalty.GET, { params: { slug: s.slug } });
    expect(after.body.data.balance).toBe(0);
    expect(after.body.data.entries.map((e: any) => e.kind)).toEqual(['reverse', 'redeem', 'earn']);
  });
});

describe('gift cards', () => {
  it('stores only a hash, supports partial redemption and never exceeds the balance', async () => {
    const s = await makeSalon();
    const g = await s.owner.call(gifts.POST, { params: { tenantSlug: s.slug }, body: { amount_minor: 15000, paid: { method: 'cash', reference: 'GC-1' } }, idempotencyKey: true });
    expect(g.status).toBe(201);
    const code: string = g.body.data.code;
    const stored = await withSystem('test', (trx) => trx.selectFrom('gift_cards').selectAll().where('id', '=', g.body.data.id).executeTakeFirstOrThrow());
    expect(JSON.stringify(stored)).not.toContain(code.replace(/-/g, ''));
    const list = await s.owner.call(gifts.GET, { params: { tenantSlug: s.slug } });
    expect(JSON.stringify(list.body)).not.toContain(code);
    const { c, id } = await bookAndPayOnSite(s, at(futureDate(4), '12:00'));
    expect((await c.call(giftBalance.POST, { params: { slug: s.slug }, body: { code } })).body.data.balance_minor).toBe(15000);
    const red = await c.call(giftRedeem.POST, { params: { slug: s.slug, id }, body: { code, amount_minor: 50000 }, idempotencyKey: true });
    expect(red.status).toBe(201);
    expect(red.body.data.redeemed_minor).toBe(10000); // capped at the booking balance
    expect(red.body.data.remaining_minor).toBe(5000);
    const b = await withTenant(s.tenantId, (trx) => trx.selectFrom('bookings').select(['paid_minor', 'payment_status']).where('id', '=', id).executeTakeFirstOrThrow());
    expect(b).toEqual({ paid_minor: 10000, payment_status: 'paid' });
    // Refunding the gift-card payment restores the card, not cash.
    await s.owner.call(refunds.POST, { params: { tenantSlug: s.slug }, body: { payment_id: red.body.data.payment_id, amount_minor: 10000, reason: 'refund to card' }, idempotencyKey: true });
    expect((await c.call(giftBalance.POST, { params: { slug: s.slug }, body: { code } })).body.data.balance_minor).toBe(15000);
    expect((await c.call(giftBalance.POST, { params: { slug: s.slug }, body: { code: 'AAAA-BBBB-CCCC-DDDD' } })).status).toBe(404);
  });
});

describe('memberships', () => {
  it('reserves on booking, consumes on completion, releases on cancellation', async () => {
    const s = await makeSalon();
    const plan = await s.owner.call(plans.POST, { params: { tenantSlug: s.slug }, body: { name_ar: 'باقة قص', price_minor: 30000, validity_days: 90, items: [{ service_id: s.services.haircut, sessions: 2 }] } });
    expect(plan.status).toBe(201);
    const c = await customer('Member');
    // The customer needs a relationship row first: a held booking creates it.
    const h1 = await c.call(hold.POST, { params: { slug: s.slug }, body: { items: [{ key: 'x', service_id: s.services.haircut, staff_id: s.staff.sara, start: at(futureDate(3), '11:00') }] }, idempotencyKey: true });
    const tc = await withTenant(s.tenantId, (trx) => trx.selectFrom('bookings').select('tenant_customer_id').where('id', '=', h1.body.data.booking_id).executeTakeFirstOrThrow());
    const sold = await s.owner.call(sell.POST, { params: { tenantSlug: s.slug }, body: { customer_id: tc.tenant_customer_id, plan_id: plan.body.data.id, method: 'cash', reference: 'M-1' }, idempotencyKey: true });
    expect(sold.status).toBe(201);
    const ap = await c.call(applyMembership.POST, { params: { slug: s.slug, id: h1.body.data.booking_id }, body: {} });
    expect(ap.body.data.totals.total).toBe(0);
    await c.call(checkout.POST, { params: { slug: s.slug, id: h1.body.data.booking_id }, body: { option: 'full' }, idempotencyKey: true });
    const ent = () => withTenant(s.tenantId, (trx) => trx.selectFrom('membership_entitlements').select(['used', 'reserved', 'total']).executeTakeFirstOrThrow());
    expect(await ent()).toEqual({ used: 0, reserved: 1, total: 2 });
    await complete(s, h1.body.data.booking_id);
    expect(await ent()).toEqual({ used: 1, reserved: 0, total: 2 });
    const h2 = await c.call(hold.POST, { params: { slug: s.slug }, body: { items: [{ key: 'x', service_id: s.services.haircut, staff_id: s.staff.sara, start: at(futureDate(5), '11:00') }] }, idempotencyKey: true });
    await c.call(applyMembership.POST, { params: { slug: s.slug, id: h2.body.data.booking_id }, body: {} });
    await c.call(checkout.POST, { params: { slug: s.slug, id: h2.body.data.booking_id }, body: { option: 'full' }, idempotencyKey: true });
    expect(await ent()).toEqual({ used: 1, reserved: 1, total: 2 });
    await c.call(accountCancel.POST, { params: { id: h2.body.data.booking_id }, body: { reason: 'travel' } });
    expect(await ent()).toEqual({ used: 1, reserved: 0, total: 2 });
    const rev = await withTenant(s.tenantId, (trx) => trx.selectFrom('financial_entries').select(['credit_minor']).where('ref_type', '=', 'membership_session').where('account', '=', 'service_revenue').execute());
    expect(rev.map((r) => r.credit_minor)).toEqual([15000]);
  });
});
