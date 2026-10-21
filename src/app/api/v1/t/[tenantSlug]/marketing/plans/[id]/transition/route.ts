import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { transitionPlan } from '@/server/domains/marketing/plans';
import { planTransitionInput } from '@/shared/schemas/marketing';


export const POST = route({
  auth: 'tenant', capability: 'marketing.manage', feature: 'feature.marketing_ai', input: planTransitionInput,
  handler: async ({ tenant, actor, params, input }) => ({ data: await transitionPlan(tenant, actor, requireUuidParam(params, 'id'), input.action, input.note) }),
});
