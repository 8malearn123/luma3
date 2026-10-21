import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { addPlanComment } from '@/server/domains/marketing/plans';
import { planCommentInput } from '@/shared/schemas/marketing';


export const POST = route({
  auth: 'tenant', capability: 'marketing.manage', feature: 'feature.marketing_ai', input: planCommentInput,
  handler: async ({ tenant, actor, params, input }) => ({ status: 201, data: await addPlanComment(tenant, actor, requireUuidParam(params, 'id'), input.body, input.plan_version_id) }),
});
