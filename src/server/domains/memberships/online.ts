import type { Tx } from '../../db/client';
import { withTenant } from '../../db/client';
import { Errors } from '../../http/errors';
import { audit, type AuditActor } from '../../infra/audit';
import { idempotent, requestHash } from '../../infra/idempotency';
import { notifyUsers } from '../../infra/notify';
import type { SessionUser } from '../../auth/service';
import { ensureTenantCustomerForUser } from '../customers/relationship';
import { createStoredValueCheckout } from '../payments/service';
import { activateMembership } from './service';

/**
 * Online membership / package purchase on the storefront. A `pending_payment`
 * membership with the plan snapshot is created with a hosted provider checkout
 * (sandbox in dev). The verified capture (paymentTargets.membership.onCaptured)
 * activates it exactly once (entitlements from the snapshot), and the payments
 * service posts Dr cash/clearing, Cr membership_liability. A free plan is
 * activated immediately.
 */
const PAYMENT_TTL_MIN = 30;

type PurchaseBody = { membership_id: string; status: 'active' | 'pending_payment'; payment: { id: string; checkout_url: string; amount_minor: number; simulation: boolean } | null };

export async function purchaseMembership(tenantId: string, slug: string, user: SessionUser, planId: string, opts: { idempotencyKey: string; actor: AuditActor; now?: Date }) {
  const now = opts.now ?? new Date();
  return withTenant(tenantId, (trx) => idempotent(trx, { scope: `tenant:${tenantId}:user:${user.userId}`, operation: 'membership.purchase', key: opts.idempotencyKey, hash: requestHash({ planId }) }, async (): Promise<{ status: number; body: PurchaseBody }> => {
    const plan = await trx.selectFrom('membership_plans').selectAll().where('id', '=', planId).where('is_active', '=', true).where('is_visible', '=', true).executeTakeFirst();
    if (!plan) throw Errors.notFound('membership_plan');
    const items = await trx.selectFrom('membership_plan_items').select(['service_id', 'sessions']).where('plan_id', '=', plan.id).execute();
    const tcId = await ensureTenantCustomerForUser(trx, tenantId, { userId: user.userId, displayName: user.displayName, phone: user.phone, email: user.email });
    const m = await trx.insertInto('customer_memberships').values({
      tenant_id: tenantId, plan_id: plan.id, tenant_customer_id: tcId, price_paid_minor: plan.price_minor, status: 'pending_payment',
      plan_snapshot: JSON.stringify({ name_ar: plan.name_ar, name_en: plan.name_en, price_minor: plan.price_minor, validity_days: plan.validity_days, items, sold_online: true }),
    }).returning('id').executeTakeFirstOrThrow();
    await audit(trx, opts.actor, 'membership.purchase_started', { tenantId, targetType: 'customer_membership', targetId: m.id, data: { plan: plan.id, price_minor: plan.price_minor } });
    if (plan.price_minor === 0) {
      await activateMembership(trx, tenantId, m.id, 0);
      return { status: 201, body: { membership_id: m.id, status: 'active', payment: null } };
    }
    const payment = await createStoredValueCheckout(trx, {
      tenantId, purpose: 'membership', membershipId: m.id, amountMinor: plan.price_minor, payerUserId: user.userId,
      idempotencyKey: `membership:${m.id}:${opts.idempotencyKey}`, description: 'Membership', returnUrl: `/s/${slug}/memberships/purchase/${m.id}`,
      expiresAt: new Date(now.getTime() + PAYMENT_TTL_MIN * 60_000),
    });
    return { status: 201, body: { membership_id: m.id, status: 'pending_payment', payment } };
  }));
}

/** paymentTargets.membership.onCaptured */
export async function activatePurchasedMembership(trx: Tx, tenantId: string, membershipId: string, payment: { paymentId: string; amountMinor: number }) {
  const m = await trx.selectFrom('customer_memberships as m').innerJoin('tenant_customers as c', 'c.id', 'm.tenant_customer_id')
    .select(['m.status', 'c.user_id', 'm.plan_snapshot']).where('m.id', '=', membershipId).executeTakeFirstOrThrow();
  if (m.status !== 'pending_payment') return { changed: false };
  const changed = await activateMembership(trx, tenantId, membershipId, payment.amountMinor);
  if (changed && m.user_id) {
    const snap = m.plan_snapshot as { name_ar?: string | null; name_en?: string | null };
    await notifyUsers(trx, tenantId, [m.user_id], {
      kind: 'membership.activated', title_ar: `تم تفعيل ${snap.name_ar ?? snap.name_en ?? 'باقتكِ'}`, title_en: `${snap.name_en ?? snap.name_ar ?? 'Your membership'} is active`,
      body_ar: 'تُطبَّق جلساتكِ تلقائياً عند الحجز.', body_en: 'Your sessions apply when you book.', dedupe_key: `membership.activated:${membershipId}`,
    });
  }
  return { changed };
}

export async function membershipPurchaseStatus(tenantId: string, userId: string, membershipId: string) {
  return withTenant(tenantId, async (trx) => {
    const m = await trx.selectFrom('customer_memberships as m').innerJoin('tenant_customers as c', 'c.id', 'm.tenant_customer_id')
      .select(['m.id', 'm.status', 'm.starts_at', 'm.ends_at', 'm.price_paid_minor', 'm.plan_snapshot', 'c.user_id']).where('m.id', '=', membershipId).executeTakeFirst();
    if (!m || m.user_id !== userId) throw Errors.notFound('membership');
    const ents = await trx.selectFrom('membership_entitlements').select(['service_id', 'total', 'used', 'reserved']).where('membership_id', '=', membershipId).execute();
    const pay = await trx.selectFrom('payments').select(['id', 'status', 'checkout_url']).where('customer_membership_id', '=', membershipId).orderBy('created_at', 'desc').executeTakeFirst();
    const { user_id: _u, ...rest } = m;
    return { ...rest, entitlements: ents, payment: pay ?? null };
  });
}
