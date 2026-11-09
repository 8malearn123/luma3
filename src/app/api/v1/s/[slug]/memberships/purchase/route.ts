import { route } from '@/server/http/route';
import { withTenant } from '@/server/db/client';
import { publicTenant, requirePublicFeature } from '@/server/domains/storefront-public';
import { purchaseMembership } from '@/server/domains/memberships/online';
import { recordAcquisition } from '@/server/domains/customers/acquisition';
import { sessionFromRequest } from '@/server/domains/analytics/events';
import { membershipPurchaseInput } from '@/shared/schemas/customer-experience';

/** POST /api/v1/s/{slug}/memberships/purchase — buy a membership/package online (hosted checkout). */
export const POST = route({
  auth: 'user', requireVerified: true, idempotency: 'required', input: membershipPurchaseInput,
  rateLimit: { scope: 'user', name: 'membership_purchase', limit: 20, windowSec: 3600 },
  handler: async ({ req, params, user, input, actor, idempotencyKey }) => {
    const t = await publicTenant(params.slug!);
    await requirePublicFeature(t.id, 'feature.memberships');
    const r = await purchaseMembership(t.id, params.slug!, user, input.plan_id, { idempotencyKey: idempotencyKey!, actor: { ...actor, kind: 'customer' } });
    const tc = await withTenant(t.id, (trx) => trx.selectFrom('tenant_customers').select('id').where('user_id', '=', user.userId).executeTakeFirst());
    const acq = tc ? await recordAcquisition(t.id, { tenantCustomerId: tc.id }, sessionFromRequest(req)) : null;
    return { status: r.status, data: { ...(r.body as object), acquisition_question: acq?.needs_question ?? false } };
  },
});
