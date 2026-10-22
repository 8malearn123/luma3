import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { requireFeature } from '@/server/tenancy/access';
import { campaignFromRecommendation } from '@/server/domains/marketing/campaigns';


export const POST = route({
  auth: 'tenant', capability: 'marketing.manage', feature: 'feature.campaigns',
  handler: async ({ tenant, actor, params }) => {
    requireFeature(tenant, 'feature.marketing_ai');
    return { status: 201, data: await campaignFromRecommendation(tenant, actor, requireUuidParam(params, 'id')) };
  },
});
