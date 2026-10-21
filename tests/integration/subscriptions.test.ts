import { describe, expect, it } from 'vitest';
import { createBusinessFor, signup } from '../helpers/factory';
import { expireStepUp, platformUser, setSubscription, stepUp, subscriptionOf } from '../helpers/platform';
import { withSystem } from '@/server/db/client';
import { runSubscriptionLifecycle } from '@/server/domains/subscriptions/service';
import * as services from '@/app/api/v1/t/[tenantSlug]/services/route';
import * as branches from '@/app/api/v1/t/[tenantSlug]/branches/route';
import * as branchOne from '@/app/api/v1/t/[tenantSlug]/branches/[id]/route';
import * as subscription from '@/app/api/v1/t/[tenantSlug]/subscription/route';
import * as preview from '@/app/api/v1/t/[tenantSlug]/subscription/preview/route';
import * as changePlan from '@/app/api/v1/t/[tenantSlug]/subscription/change-plan/route';
import * as cancel from '@/app/api/v1/t/[tenantSlug]/subscription/cancel/route';
import * as subAction from '@/app/api/v1/platform/subscriptions/[id]/actions/route';
import * as subDetail from '@/app/api/v1/platform/subscriptions/[id]/route';
import * as invoices from '@/app/api/v1/platform/subscriptions/[id]/invoices/route';
import * as invoiceOne from '@/app/api/v1/platform/invoices/[id]/route';
import * as plans from '@/app/api/v1/platform/plans/route';
import * as planOne from '@/app/api/v1/platform/plans/[id]/route';
import * as revenue from '@/app/api/v1/platform/revenue/route';

const branch = (name: string) => ({ name, timezone: 'Asia/Riyadh', hours: [{ weekday: 0, opens: '10:00', closes: '14:00' }, { weekday: 0, opens: '16:00', closes: '22:00' }] });

describe('plan limits & downgrades', () => {
  it('blocks branches beyond limit.branches through the API', async () => {
    const owner = await signup('Sanaa owner');
    const biz = await createBusinessFor(owner); // sanaa: 1 branch
    const r = await owner.call(branches.POST, { params: { tenantSlug: biz.slug }, body: branch('Second') });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('plan_limit_reached');
    expect(r.body.error.details.feature).toBe('limit.branches');
  });

  it('downgrade preserves data, records overage_state, blocks over-limit creation, and upgrade clears it', async () => {
    const owner = await signup('Wahaj owner');
    const biz = await createBusinessFor(owner, { plan_code: 'wahaj' });
    const p = { tenantSlug: biz.slug };
    const b2 = await owner.call(branches.POST, { params: p, body: branch('North') });
    expect(b2.status).toBe(201);
    expect(b2.body.data.is_primary).toBe(false);

    const pv = await owner.call(preview.GET, { params: p, query: { plan_code: 'sanaa' } });
    expect(pv.body.data).toMatchObject({ direction: 'downgrade', requires_confirmation: true });
    expect(pv.body.data.overages).toEqual([{ key: 'limit.branches', limit: 1, used: 2 }]);

    const noConfirm = await owner.call(changePlan.POST, { params: p, body: { plan_code: 'sanaa' } });
    expect(noConfirm.status).toBe(409);
    expect(noConfirm.body.error.code).toBe('downgrade_confirmation_required');
    const down = await owner.call(changePlan.POST, { params: p, body: { plan_code: 'sanaa', confirm_overage: true } });
    expect(down.status).toBe(200);
    expect(down.body.data.overage_state.exceeded[0]).toMatchObject({ key: 'limit.branches', limit: 1, used: 2 });

    // Nothing was deleted; the business keeps both branches.
    const list = await owner.call(branches.GET, { params: p });
    expect(list.body.data.items.filter((b: any) => b.status === 'active')).toHaveLength(2);
    expect((await subscriptionOf(biz.tenantId)).overage_state).not.toBeNull();
    // Creating more of the exceeded resource is blocked until resolved.
    expect((await owner.call(branches.POST, { params: p, body: branch('South') })).status).toBe(403);
    // Other resources still work.
    expect((await owner.call(services.POST, { params: p, body: { name_ar: 'قص', price_minor: 5000, duration_min: 30 } })).status).toBe(201);

    const ov = await owner.call(subscription.GET, { params: p });
    expect(ov.body.data.subscription.plan.code).toBe('sanaa');
    expect(ov.body.data.usage.find((u: any) => u.key === 'limit.branches')).toMatchObject({ used: 2, limit: 1 });

    const up = await owner.call(changePlan.POST, { params: p, body: { plan_code: 'fareed' } });
    expect(up.status).toBe(200);
    expect(up.body.data.direction).toBe('upgrade');
    expect(up.body.data.overage_state).toBeNull();
    expect((await subscriptionOf(biz.tenantId)).overage_state).toBeNull();
    expect((await owner.call(branches.POST, { params: p, body: branch('South') })).status).toBe(201);
  });

  it('resolving an overage by archiving clears the transition state', async () => {
    const owner = await signup('Resolver');
    const biz = await createBusinessFor(owner, { plan_code: 'wahaj' });
    const p = { tenantSlug: biz.slug };
    const b2 = await owner.call(branches.POST, { params: p, body: branch('Extra') });
    await owner.call(changePlan.POST, { params: p, body: { plan_code: 'sanaa', confirm_overage: true } });
    const ar = await owner.call(branchOne.PATCH, { params: { ...p, id: b2.body.data.id }, body: { version: b2.body.data.version, status: 'archived' } });
    expect(ar.status).toBe(200);
    expect((await subscriptionOf(biz.tenantId)).overage_state).toBeNull();
    const list = await owner.call(branches.GET, { params: p });
    expect(list.body.data.items.find((b: any) => b.id === b2.body.data.id).status).toBe('archived'); // archived, not deleted
  });
});

describe('subscription lifecycle', () => {
  it('trial end → past_due with grace → expired (read-only, data intact) → reactivated', async () => {
    const owner = await signup('Lifecycle owner');
    const biz = await createBusinessFor(owner);
    const p = { tenantSlug: biz.slug };
    const svc = await owner.call(services.POST, { params: p, body: { name_ar: 'صبغة', price_minor: 25000, duration_min: 60 } });
    expect(svc.status).toBe(201);

    await setSubscription(biz.tenantId, { trial_ends_at: new Date(Date.now() - 3_600_000) });
    const r1 = await runSubscriptionLifecycle();
    expect(r1.trial_ended).toBeGreaterThanOrEqual(1);
    let sub = await subscriptionOf(biz.tenantId);
    expect(sub.status).toBe('past_due');
    expect(sub.grace_until!.getTime()).toBeGreaterThan(Date.now()); // 7-day grace from plan.grace_days
    // Within grace, the workspace still works.
    expect((await owner.call(services.POST, { params: p, body: { name_ar: 'قص', price_minor: 5000, duration_min: 30 } })).status).toBe(201);

    await setSubscription(biz.tenantId, { grace_until: new Date(Date.now() - 1000) });
    await runSubscriptionLifecycle();
    sub = await subscriptionOf(biz.tenantId);
    expect(sub.status).toBe('expired');
    const blocked = await owner.call(services.POST, { params: p, body: { name_ar: 'x', price_minor: 1, duration_min: 30 } });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.details.reason).toBe('read_only');
    const read = await owner.call(services.GET, { params: p });
    expect(read.status).toBe(200);
    expect(read.body.data).toHaveLength(2); // data intact

    const admin = await platformUser('platform_owner', 'Billing admin');
    await expireStepUp(admin.identifier);
    const needStep = await admin.call(subAction.POST, { params: { id: sub.id }, body: { action: 'reactivate', reason: 'payment confirmed (test)' } });
    expect(needStep.status).toBe(401);
    await stepUp(admin);
    const re = await admin.call(subAction.POST, { params: { id: sub.id }, body: { action: 'reactivate', reason: 'payment confirmed (test)' } });
    expect(re.status).toBe(200);
    expect(re.body.data.status).toBe('active');
    expect((await owner.call(services.POST, { params: p, body: { name_ar: 'بروتين', price_minor: 60000, duration_min: 90 } })).status).toBe(201);

    const detail = await admin.call(subDetail.GET, { params: { id: sub.id } });
    expect(detail.body.data.events.map((e: any) => e.kind)).toEqual(expect.arrayContaining(['trial_started', 'trial_ended', 'grace_expired', 'platform.reactivate']));

    // subscription_events is append-only.
    await expect(withSystem('test: tamper', (trx) => trx.updateTable('subscription_events').set({ kind: 'tampered' }).where('subscription_id', '=', sub.id).execute())).rejects.toThrow();
    await expect(withSystem('test: tamper', (trx) => trx.deleteFrom('subscription_events').where('subscription_id', '=', sub.id).execute())).rejects.toThrow();
  });

  it('platform actions: extend trial, pause/resume, cancel at period end, invalid transitions', async () => {
    const owner = await signup('Actions owner');
    const biz = await createBusinessFor(owner);
    const admin = await platformUser('platform_owner', 'Ops');
    const sub = await subscriptionOf(biz.tenantId);
    const ext = await admin.call(subAction.POST, { params: { id: sub.id }, body: { action: 'extend_trial', days: 10, reason: 'requested more time' } });
    expect(ext.status).toBe(200);
    expect(new Date(ext.body.data.trial_ends_at).getTime()).toBeGreaterThan(sub.trial_ends_at!.getTime() + 9 * 86_400_000);
    const grace = await admin.call(subAction.POST, { params: { id: sub.id }, body: { action: 'set_grace', days: 5, reason: 'only for past due' } });
    expect(grace.status).toBe(409);
    expect((await admin.call(subAction.POST, { params: { id: sub.id }, body: { action: 'pause', reason: 'salon renovation' } })).body.data.status).toBe('paused');
    // A paused workspace is read-only: data stays visible, writes are refused.
    const blocked = await owner.call(services.POST, { params: { tenantSlug: biz.slug }, body: { name_ar: 'خدمة', price_minor: 1000, duration_min: 30 } });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.details?.reason).toBe('read_only');
    expect((await admin.call(subAction.POST, { params: { id: sub.id }, body: { action: 'resume', reason: 'salon reopened' } })).body.data.status).toBe('trialing');
    const short = await admin.call(subAction.POST, { params: { id: sub.id }, body: { action: 'pause', reason: 'short' } });
    expect(short.status).toBe(422);

    const c = await owner.call(cancel.POST, { params: { tenantSlug: biz.slug }, body: { action: 'cancel_at_period_end' } });
    expect(c.status).toBe(200);
    await setSubscription(biz.tenantId, { cancel_at: new Date(Date.now() - 1000) });
    await runSubscriptionLifecycle();
    expect((await subscriptionOf(biz.tenantId)).status).toBe('cancelled');
  });

  it('test-mode billing: priced plans issue labelled test invoices; marking paid reactivates; revenue is separate', async () => {
    const admin = await platformUser('platform_owner', 'Pricing admin');
    const list = await admin.call(plans.GET);
    const wahaj = list.body.data.find((p: any) => p.code === 'wahaj');
    const upd = await admin.call(planOne.PUT, { params: { id: wahaj.id }, body: { version: wahaj.version, price_monthly_minor: 19900, price_is_test: true } });
    expect(upd.status).toBe(200);
    expect(upd.body.data.price_is_test).toBe(true);
    const stale = await admin.call(planOne.PUT, { params: { id: wahaj.id }, body: { version: wahaj.version, price_monthly_minor: 1 } });
    expect(stale.status).toBe(409);

    const owner = await signup('Billing owner');
    const biz = await createBusinessFor(owner, { plan_code: 'wahaj' });
    const sub = await subscriptionOf(biz.tenantId);
    await admin.call(subAction.POST, { params: { id: sub.id }, body: { action: 'activate', reason: 'converted after trial' } });
    await setSubscription(biz.tenantId, { current_period_end: new Date(Date.now() - 1000) });
    const r = await runSubscriptionLifecycle();
    expect(r.invoiced).toBeGreaterThanOrEqual(1);
    const after = await subscriptionOf(biz.tenantId);
    expect(after.status).toBe('past_due');
    const detail = await admin.call(subDetail.GET, { params: { id: sub.id } });
    const inv = detail.body.data.invoices[0];
    expect(inv).toMatchObject({ is_test: true, status: 'open', amount_minor: 19900 });
    expect(inv.number).toMatch(/^LUMA-TEST-/);
    const paid = await admin.call(invoiceOne.POST, { params: { id: inv.id }, body: { action: 'mark_paid', note: 'manual test settlement' } });
    expect(paid.status).toBe(200);
    expect((await subscriptionOf(biz.tenantId)).status).toBe('active');
    const manual = await admin.call(invoices.POST, { params: { id: sub.id }, body: {} });
    expect(manual.status).toBe(201);

    const rev = await admin.call(revenue.GET);
    expect(rev.body.data.is_test).toBe(true);
    expect(rev.body.data.monthly[0].paid_minor).toBeGreaterThanOrEqual(19900);

    // Unpriced plans never generate invoices.
    const sanaaOwner = await signup('Unpriced');
    const biz2 = await createBusinessFor(sanaaOwner);
    const sub2 = await subscriptionOf(biz2.tenantId);
    const none = await admin.call(invoices.POST, { params: { id: sub2.id }, body: {} });
    expect(none.status).toBe(422);
    expect(none.body.error.code).toBe('pricing_not_configured');
    // Restore: pricing not configured.
    const fresh = (await admin.call(plans.GET)).body.data.find((p: any) => p.code === 'wahaj');
    await admin.call(planOne.PUT, { params: { id: wahaj.id }, body: { version: fresh.version, price_monthly_minor: null } });
  });
});
