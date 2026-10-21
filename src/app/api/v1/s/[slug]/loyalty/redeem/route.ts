import { z } from 'zod';
import { route } from '@/server/http/route';
import { withTenant } from '@/server/db/client';
import { redeemReward } from '@/server/domains/loyalty/service';
import { publicTenant, requirePublicFeature } from '@/server/domains/storefront-public';
import { ensureTenantCustomerForUser } from '@/server/domains/customers/relationship';

export const POST = route({
  auth: 'user', requireVerified: true, idempotency: 'required', input: z.object({ reward_id: z.string().uuid() }),
  handler: async ({ params, user, input, actor, idempotencyKey }) => {
    const t = await publicTenant(params.slug!);
    await requirePublicFeature(t.id, 'feature.loyalty');
    const tc = await withTenant(t.id, (trx) => ensureTenantCustomerForUser(trx, t.id, { userId: user.userId, displayName: user.displayName, phone: user.phone, email: user.email }));
    return { status: 201, data: await redeemReward(t.id, tc, input.reward_id, `${user.userId}:${idempotencyKey}`, { ...actor, kind: 'customer' }) };
  },
});
