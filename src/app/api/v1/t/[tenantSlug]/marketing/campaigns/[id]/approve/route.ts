import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { approveCampaign } from '@/server/domains/marketing/campaigns';


export const POST = route({
  auth: 'tenant', capability: 'campaigns.approve', feature: 'feature.campaigns',
  handler: async ({ tenant, actor, params }) => ({ data: await approveCampaign(tenant, actor, requireUuidParam(params, 'id')) }),
});
