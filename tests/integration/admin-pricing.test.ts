import { afterAll, describe, expect, it } from 'vitest';
import { createBusinessFor, signup, uniq } from '../helpers/factory';
import { platformUser, stepUp, subscriptionOf } from '../helpers/platform';
import { withSystem } from '@/server/db/client';
import { resetPlatformSettingsCache } from '@/server/domains/platform/settings';
import * as pricing from '@/app/api/v1/pricing/route';
import * as plans from '@/app/api/v1/platform/plans/route';
import * as founding from '@/app/api/v1/platform/founding/route';
import * as promotions from '@/app/api/v1/platform/promotions/route';
import * as promotionOne from '@/app/api/v1/platform/promotions/[id]/route';
import * as settings from '@/app/api/v1/platform/settings/route';
import * as subAction from '@/app/api/v1/platform/subscriptions/[id]/actions/route';
import * as subInvoices from '@/app/api/v1/platform/subscriptions/[id]/invoices/route';
import * as invoiceOne from '@/app/api/v1/platform/invoices/[id]/route';
import * as ownerSub from '@/app/api/v1/t/[tenantSlug]/subscription/route';
import { TestClient } from '../helpers/http';

async function setFounding(patch: Record<string, unknown>) {
  await withSystem('test: founding settings', async (trx) => {
    for (const [k, v] of Object.entries(patch)) {
      await trx.insertInto('platform_settings').values({ key: k, value: JSON.stringify(v) }).onConflict((oc) => oc.column('key').doUpdateSet({ value: JSON.stringify(v) })).execute();
    }
  });
  resetPlatformSettingsCache();
}

afterAll(async () => {
  await withSystem('test: reset settings', (trx) => trx.deleteFrom('platform_settings').where('key', 'in', ['founding_seats_total', 'founding_enabled']).execute());
  resetPlatformSettingsCache();
});

describe('plan prices (data, migration 0630)', () => {
  it('seeds 199 / 399 / 799 SAR monthly, yearly = two months free, no booking limit, and shows founding seats publicly', async () => {
    const r = await new TestClient().call(pricing.GET);
    expect(r.status).toBe(200);
    const by = Object.fromEntries(r.body.data.plans.map((p: any) => [p.code, p]));
    expect(by.sanaa).toMatchObject({ price_monthly_minor: 19900, price_yearly_minor: 199000, price_is_test: false });
    expect(by.wahaj).toMatchObject({ price_monthly_minor: 39900, price_yearly_minor: 399000 });
    expect(by.fareed).toMatchObject({ price_monthly_minor: 79900, price_yearly_minor: 799000 });
    for (const p of Object.values(by) as any[]) expect(p.price_yearly_minor).toBe(p.price_monthly_minor * 10);
    expect(by.sanaa.yearly_saving_minor).toBe(19900 * 2);
    expect(r.body.data.vat_inclusive).toBe(true);
    expect(r.body.data.monthly_bookings_limit).toBeNull();
    expect(r.body.data.founding).toMatchObject({ enabled: true, total: 100, discount_bp: 3000 });
    expect(r.body.data.founding.remaining).toBe(100 - r.body.data.founding.taken);
    // Founding price shown next to the list price: 30% off 199 = 139.30.
    if (r.body.data.founding.remaining > 0) expect(by.sanaa.cycles[0]).toMatchObject({ cycle: 'monthly', list_minor: 19900, founding_minor: 13930 });

    const admin = await platformUser('platform_owner', 'Pricing reader');
    const list = (await admin.call(plans.GET)).body.data;
    expect(list.find((p: any) => p.code === 'fareed').price_monthly_minor).toBe(79900);
  });
});

describe('founding customers', () => {
  it('first paying subscribers get a permanent 30% seat until the subscription ends; seats run out at the configured total', async () => {
    const admin = await platformUser('platform_owner', 'Founding admin');
    const taken = (await admin.call(founding.GET)).body.data.taken as number;
    await setFounding({ founding_seats_total: taken + 1, founding_enabled: true });

    // Seat 1 of 1 remaining: activation assigns it.
    const o1 = await signup('Founder one');
    const b1 = await createBusinessFor(o1, { plan_code: 'wahaj', billing_cycle: 'yearly' });
    const s1 = await subscriptionOf(b1.tenantId);
    expect(s1.billing_cycle).toBe('yearly');
    const act = await admin.call(subAction.POST, { params: { id: s1.id }, body: { action: 'activate', reason: 'first paying founder' } });
    expect(act.status).toBe(200);
    const after1 = await subscriptionOf(b1.tenantId);
    expect(after1.founding_number).toBe(taken + 1);
    expect(after1.founding_discount_bp).toBe(3000);
    // Yearly wahaj 3,990 × 70% = 2,793.00
    const inv1 = await admin.call(subInvoices.POST, { params: { id: s1.id }, body: {} });
    expect(inv1.status).toBe(201);
    expect(inv1.body.data).toMatchObject({ list_amount_minor: 399000, amount_minor: 279300, discount_minor: 119700 });
    const ov = await o1.call(ownerSub.GET, { params: { tenantSlug: b1.slug } });
    expect(ov.body.data.subscription.founding).toMatchObject({ number: taken + 1, active: true });

    const seats = (await admin.call(founding.GET)).body.data;
    expect(seats.remaining).toBe(0);
    expect(seats.holders.some((h: any) => h.tenant_slug === b1.slug)).toBe(true);
    expect((await new TestClient().call(pricing.GET)).body.data.founding.remaining).toBe(0);

    // No seat left: the next subscriber pays the list price.
    const o2 = await signup('Late subscriber');
    const b2 = await createBusinessFor(o2, { plan_code: 'sanaa' });
    const s2 = await subscriptionOf(b2.tenantId);
    const inv2 = await admin.call(subInvoices.POST, { params: { id: s2.id }, body: {} });
    expect(inv2.body.data).toMatchObject({ list_amount_minor: 19900, amount_minor: 19900 });
    expect((await subscriptionOf(b2.tenantId)).founding_number).toBeNull();

    // Paying the first invoice keeps the seat; cancelling loses the discount for good (seat not reassigned).
    await admin.call(invoiceOne.POST, { params: { id: inv1.body.data.id }, body: { action: 'mark_paid' } });
    await admin.call(subAction.POST, { params: { id: s1.id }, body: { action: 'cancel', reason: 'founder cancelled the plan' } });
    const lost = await subscriptionOf(b1.tenantId);
    expect(lost.founding_lost_at).not.toBeNull();
    expect((await admin.call(founding.GET)).body.data.remaining).toBe(0);
  });

  it('the platform owner edits seat count and discount in settings (step-up)', async () => {
    const admin = await platformUser('platform_owner', 'Settings founding');
    await stepUp(admin);
    const r = await admin.call(settings.PUT, { method: 'PUT', body: { founding_seats_total: 100, founding_discount_bp: 3000 } });
    expect(r.status).toBe(200);
    expect(r.body.data.founding_seats_total).toBe(100);
  });
});

describe('plan promotions', () => {
  it('a code applies a time-limited % discount at subscription; automatic offers apply without a code; limits and expiry hold', async () => {
    const admin = await platformUser('platform_owner', 'Promo admin');
    await setFounding({ founding_enabled: false });
    await stepUp(admin);
    const code = `RAMADAN${uniq().slice(0, 4).toUpperCase()}`;
    const now = Date.now();
    const created = await admin.call(promotions.POST, { body: {
      code, name_ar: 'عرض رمضان', name_en: 'Ramadan offer', discount_bp: 2000, plan_codes: ['wahaj'], billing_cycles: ['monthly'],
      starts_at: new Date(now - 60_000).toISOString(), ends_at: new Date(now + 7 * 86_400_000).toISOString(), duration_cycles: 1, max_redemptions: 1,
    } });
    expect(created.status).toBe(201);

    // Wrong plan → 422; right plan → discount recorded on the subscription.
    const bad = await (await signup('Promo wrong plan')).call((await import('@/app/api/v1/tenants/route')).POST, { body: { name: 'x', slug: `t-${uniq()}`, business_type: 'salon', plan_code: 'sanaa', promo_code: code } });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('promotion_invalid');
    const o = await signup('Promo owner');
    const b = await createBusinessFor(o, { plan_code: 'wahaj', promo_code: code.toLowerCase() });
    const s = await subscriptionOf(b.tenantId);
    expect(s.promotion_discount_bp).toBe(2000);
    expect(s.promotion_cycles_remaining).toBe(1);
    // First invoice: 399 × 80% = 319.20; the one-cycle promo is then used up.
    const inv = await admin.call(subInvoices.POST, { params: { id: s.id }, body: {} });
    expect(inv.body.data).toMatchObject({ list_amount_minor: 39900, amount_minor: 31920 });
    const inv2 = await admin.call(subInvoices.POST, { params: { id: s.id }, body: {} });
    expect(inv2.body.data.amount_minor).toBe(39900);
    // max_redemptions = 1 → exhausted.
    const again = await (await signup('Promo second')).call((await import('@/app/api/v1/tenants/route')).POST, { body: { name: 'y', slug: `t-${uniq()}`, business_type: 'salon', plan_code: 'wahaj', promo_code: code } });
    expect(again.status).toBe(422);

    // Automatic offer (no code): applied to new subscriptions while running; disabling stops it.
    const auto = await admin.call(promotions.POST, { body: {
      name_ar: 'خصم الإطلاق', name_en: 'Launch discount', discount_bp: 1500, plan_codes: ['fareed'],
      starts_at: new Date(now - 60_000).toISOString(), ends_at: new Date(now + 86_400_000).toISOString(),
    } });
    expect(auto.status).toBe(201);
    const pub = await new TestClient().call(pricing.GET);
    const fareed = pub.body.data.plans.find((p: any) => p.code === 'fareed');
    expect(fareed.cycles[0].promotion.discount_bp).toBe(1500);
    expect(fareed.cycles[0].promo_minor).toBe(67915);
    const b3 = await createBusinessFor(await signup('Auto promo'), { plan_code: 'fareed' });
    expect((await subscriptionOf(b3.tenantId)).promotion_discount_bp).toBe(1500);
    const off = await admin.call(promotionOne.PATCH, { method: 'PATCH', params: { id: auto.body.data.id }, body: { version: 1, status: 'disabled' } });
    expect(off.status).toBe(200);
    const b4 = await createBusinessFor(await signup('After promo'), { plan_code: 'fareed' });
    expect((await subscriptionOf(b4.tenantId)).promotion_id).toBeNull();
    await setFounding({ founding_enabled: true });
  });
});
