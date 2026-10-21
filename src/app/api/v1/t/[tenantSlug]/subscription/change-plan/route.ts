import { route } from '@/server/http/route';
import { changePlan } from '@/server/domains/subscriptions/service';
import { planChangeInput } from '@/shared/schemas/settings';

/** POST /api/v1/t/:slug/subscription/change-plan — upgrade now; downgrade needs confirm_overage when over limits. */
export const POST = route({
  auth: 'tenant', capability: 'subscription.manage', input: planChangeInput, allowReadOnly: true,
  handler: async ({ tenant, actor, input }) => ({ data: await changePlan(tenant, actor, input) }),
});
