import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { decideRecommendation } from '@/server/domains/marketing/recommendations';
import { recommendationDecision } from '@/shared/schemas/marketing';


export const POST = route({
  auth: 'tenant', capability: 'marketing.manage', feature: 'feature.marketing_ai', input: recommendationDecision,
  handler: async ({ tenant, actor, params, input }) => ({ data: await decideRecommendation(tenant, actor, requireUuidParam(params, 'id'), input) }),
});
