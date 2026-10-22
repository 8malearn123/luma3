import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { cancelCampaign } from '@/server/domains/marketing/campaigns';


export const POST = route({
  auth: 'tenant', capability: ['marketing.manage', 'campaigns.approve'], feature: 'feature.campaigns',
  handler: async ({ tenant, actor, params }) => ({ data: await cancelCampaign(tenant, actor, requireUuidParam(params, 'id')) }),
});
