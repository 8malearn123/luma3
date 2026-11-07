import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { createBusinessFor, signup, uniq } from '../helpers/factory';
import { platformUser, stepUp, subscriptionOf } from '../helpers/platform';
import { withSystem } from '@/server/db/client';
import { resetPlatformSettingsCache } from '@/server/domains/platform/settings';
import * as refLink from '@/app/r/[code]/route';
import * as referrals from '@/app/api/v1/platform/referrals/route';
import * as referrerOne from '@/app/api/v1/platform/referrals/[id]/route';
import * as onBehalf from '@/app/api/v1/platform/referrals/[id]/withdrawals/route';
import * as withdrawals from '@/app/api/v1/platform/withdrawals/route';
import * as withdrawalOne from '@/app/api/v1/platform/withdrawals/[id]/route';
import * as subInvoices from '@/app/api/v1/platform/subscriptions/[id]/invoices/route';
import * as invoiceOne from '@/app/api/v1/platform/invoices/[id]/route';
import * as bizRef from '@/app/api/v1/t/[tenantSlug]/referrals/route';
import * as bizWithdraw from '@/app/api/v1/t/[tenantSlug]/referrals/withdrawals/route';

const IBAN = 'SA0380000000608010167519';

// Minimum withdrawal 10 SAR for these tests (default 100 SAR).
beforeAll(async () => {
  await withSystem('test: min withdrawal', (trx) => trx.insertInto('platform_settings').values({ key: 'referral_min_withdrawal_minor', value: '1000' })
    .onConflict((oc) => oc.column('key').doUpdateSet({ value: '1000' })).execute());
  resetPlatformSettingsCache();
});
afterAll(async () => {
  await withSystem('test: reset', (trx) => trx.deleteFrom('platform_settings').where('key', '=', 'referral_min_withdrawal_minor').execute());
  resetPlatformSettingsCache();
});

/** Issues and marks paid the referred business's first LUMA invoice. */
async function payFirstInvoice(admin: Awaited<ReturnType<typeof platformUser>>, tenantId: string) {
  const sub = await subscriptionOf(tenantId);
  const inv = await admin.call(subInvoices.POST, { params: { id: sub.id }, body: {} });
  expect(inv.status).toBe(201);
  const paid = await admin.call(invoiceOne.POST, { params: { id: inv.body.data.id }, body: { action: 'mark_paid' } });
  expect(paid.status).toBe(200);
  return inv.body.data as { id: string; amount_minor: number };
}

describe('referrals: business refers business', () => {
  it('link cookie is captured at business creation; first paid month rewards 10%; balance → withdrawal → approve → paid', async () => {
    const admin = await platformUser('platform_owner', 'Referral admin');
    await stepUp(admin);
    const referrerOwner = await signup('Referring expert');
    const ref = await createBusinessFor(referrerOwner, { business_type: 'expert' });
    const ov = await referrerOwner.call(bizRef.GET, { params: { tenantSlug: ref.slug } });
    expect(ov.status).toBe(200);
    const code: string = ov.body.data.code;
    expect(ov.body.data.link).toMatch(new RegExp(`/r/${code}$`));
    expect(ov.body.data.rate_bp).toBe(1000);
    expect(ov.body.data.balance.balance).toBe(0);

    // /r/{code} sets the referral cookie and redirects to sign-up.
    const res = await refLink.GET(new NextRequest(`http://localhost:3000/r/${code}`), { params: Promise.resolve({ code }) });
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/auth/register');
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith('luma_ref='))!;
    expect(cookie).toContain(`luma_ref=${code}`);

    const newcomer = await signup('Referred expert');
    newcomer.cookies.set('luma_ref', code);
    const referred = await createBusinessFor(newcomer, { business_type: 'expert', plan_code: 'wahaj' });
    expect((referred as any).referral_applied).toBe(true);
    const after = await referrerOwner.call(bizRef.GET, { params: { tenantSlug: ref.slug } });
    expect(after.body.data.referred).toHaveLength(1);
    expect(after.body.data.referred[0]).toMatchObject({ status: 'pending', referred_name: 'صالون تجريبي' });

    // Self-referral via the own code is ignored.
    const self = await createBusinessFor(referrerOwner, { referral_code: code });
    expect((self as any).referral_applied).toBe(false);

    const inv = await payFirstInvoice(admin, referred.tenantId);
    const expected = Math.round(inv.amount_minor * 0.1);
    const rewarded = await referrerOwner.call(bizRef.GET, { params: { tenantSlug: ref.slug } });
    expect(rewarded.body.data.referred[0]).toMatchObject({ status: 'rewarded', reward_minor: expected });
    expect(rewarded.body.data.balance.balance).toBe(expected);
    // Paying a second invoice does not reward again.
    await payFirstInvoice(admin, referred.tenantId);
    expect((await referrerOwner.call(bizRef.GET, { params: { tenantSlug: ref.slug } })).body.data.balance.balance).toBe(expected);

    // Withdrawal: owner + step-up; more than the balance → 409; below minimum → 422.
    await stepUp(referrerOwner);
    const tooMuch = await referrerOwner.call(bizWithdraw.POST, { params: { tenantSlug: ref.slug }, body: { amount_minor: expected + 1, iban: IBAN, account_name: 'Referring expert' } });
    expect(tooMuch.status).toBe(409);
    expect(tooMuch.body.error.code).toBe('insufficient_balance');
    const tiny = await referrerOwner.call(bizWithdraw.POST, { params: { tenantSlug: ref.slug }, body: { amount_minor: 500, iban: IBAN, account_name: 'Referring expert' } });
    expect(tiny.status).toBe(422);
    expect(tiny.body.error.code).toBe('withdrawal_below_minimum');
    const w = await referrerOwner.call(bizWithdraw.POST, { params: { tenantSlug: ref.slug }, body: { amount_minor: expected, iban: 'SA03 8000 0000 6080 1016 7519', account_name: 'Referring expert' } });
    expect(w.status).toBe(201);
    expect(w.body.data.iban).toMatch(/^SA03••••7519$/);
    expect((await referrerOwner.call(bizRef.GET, { params: { tenantSlug: ref.slug } })).body.data.balance.balance).toBe(0);
    const again = await referrerOwner.call(bizWithdraw.POST, { params: { tenantSlug: ref.slug }, body: { amount_minor: expected, iban: IBAN, account_name: 'x y' } });
    expect(again.status).toBe(409);

    const queue = await admin.call(withdrawals.GET, { query: { status: 'requested' } });
    const item = queue.body.data.items.find((x: any) => x.id === w.body.data.id);
    expect(item.iban).toBe(IBAN);
    expect((await admin.call(withdrawalOne.POST, { params: { id: item.id }, body: { action: 'mark_paid', reference: 'TRX-1' } })).status).toBe(409);
    expect((await admin.call(withdrawalOne.POST, { params: { id: item.id }, body: { action: 'approve' } })).status).toBe(200);
    const paid = await admin.call(withdrawalOne.POST, { params: { id: item.id }, body: { action: 'mark_paid', reference: 'TRX-1' } });
    expect(paid.body.data.status).toBe('paid');
    const final = (await referrerOwner.call(bizRef.GET, { params: { tenantSlug: ref.slug } })).body.data;
    expect(final.balance).toMatchObject({ balance: 0, earned: expected, withdrawn: expected, held: 0 });

    // The ledger is append-only.
    await expect(withSystem('test', (trx) => trx.updateTable('referral_ledger').set({ amount_minor: 1 }).execute())).rejects.toThrow();

    // Leaderboard lists the referrer with its earnings.
    const lb = await admin.call(referrals.GET);
    expect(lb.body.data.leaderboard.some((r: any) => r.code === code && r.earned === expected)).toBe(true);
  });
});

describe('referrals: marketers (affiliates)', () => {
  it('marketer code typed at signup; per-marketer rate; rejection releases the held amount', async () => {
    const admin = await platformUser('platform_owner', 'Marketer admin');
    const code = `MKT${uniq().slice(0, 5).toUpperCase()}`;
    const m = await admin.call(referrals.POST, { body: { display_name: 'نورة المسوّقة', code, rate_bp: 2000, contact_phone: '+966500000001' } });
    expect(m.status).toBe(201);
    const dup = await admin.call(referrals.POST, { body: { display_name: 'dup', code } });
    expect(dup.status).toBe(409);

    const o = await signup('Via marketer');
    const biz = await createBusinessFor(o, { referral_code: code });
    expect((biz as any).referral_applied).toBe(true);
    const inv = await payFirstInvoice(admin, biz.tenantId);
    const detail = await admin.call(referrerOne.GET, { params: { id: m.body.data.id } });
    const reward = Math.round(inv.amount_minor * 0.2);
    expect(detail.body.data.balance.balance).toBe(reward);
    expect(detail.body.data.referred[0]).toMatchObject({ status: 'rewarded', rate_bp: 2000 });

    const w = await admin.call(onBehalf.POST, { params: { id: m.body.data.id }, body: { amount_minor: reward, iban: IBAN, account_name: 'Noura' } });
    expect(w.status).toBe(201);
    await stepUp(admin);
    const rej = await admin.call(withdrawalOne.POST, { params: { id: w.body.data.id }, body: { action: 'reject', reason: 'IBAN name does not match the marketer' } });
    expect(rej.body.data.status).toBe('rejected');
    expect((await admin.call(referrerOne.GET, { params: { id: m.body.data.id } })).body.data.balance.balance).toBe(reward);

    // Rate edits are versioned and step-up protected.
    const upd = await admin.call(referrerOne.PATCH, { method: 'PATCH', params: { id: m.body.data.id }, body: { version: 1, rate_bp: 1500 } });
    expect(upd.status).toBe(200);
    expect(upd.body.data.rate_bp).toBe(1500);

    // Platform-only: a business owner cannot reach the marketer endpoints.
    expect((await o.call(referrals.GET)).status).toBe(404);
    // Business referral screen needs business.manage (owner).
    expect((await o.call(bizRef.GET, { params: { tenantSlug: biz.slug } })).status).toBe(200);
  });
});
