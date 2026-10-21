import { z } from 'zod';
import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { requireFeature } from '@/server/tenancy/access';
import { campaignFromPlan } from '@/server/domains/marketing/campaigns';


export const POST = route({
  auth: 'tenant', capability: 'marketing.manage', feature: 'feature.campaigns',
  input: z.object({ activity_id: z.string().max(40).optional() }).strict(),
  handler: async ({ tenant, actor, params, input }) => {
    requireFeature(tenant, 'feature.marketing_ai');
    return { status: 201, data: await campaignFromPlan(tenant, actor, requireUuidParam(params, 'id'), input.activity_id) };
  },
});
