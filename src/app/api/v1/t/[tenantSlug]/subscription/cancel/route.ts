import { route } from '@/server/http/route';
import { setCancelAtPeriodEnd } from '@/server/domains/subscriptions/service';
import { cancelInput } from '@/shared/schemas/settings';

/** POST /api/v1/t/:slug/subscription/cancel — cancel at period end, or keep the subscription. */
export const POST = route({
  auth: 'tenant', capability: 'subscription.manage', input: cancelInput, allowReadOnly: true,
  handler: async ({ tenant, actor, input }) => ({ data: await setCancelAtPeriodEnd(tenant, actor, input.action === 'cancel_at_period_end') }),
});
