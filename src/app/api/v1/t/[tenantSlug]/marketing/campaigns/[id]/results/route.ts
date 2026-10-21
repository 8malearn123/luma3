import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { campaignResults } from '@/server/domains/marketing/campaigns';


export const GET = route({
  auth: 'tenant', capability: ['marketing.view', 'marketing.manage', 'campaigns.approve'], feature: 'feature.campaigns',
  handler: async ({ tenant, params }) => ({ data: await campaignResults(tenant, requireUuidParam(params, 'id')) }),
});
