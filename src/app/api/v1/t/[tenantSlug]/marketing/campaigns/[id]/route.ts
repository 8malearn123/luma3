import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { getCampaign, updateCampaign } from '@/server/domains/marketing/campaigns';
import { campaignPatch } from '@/shared/schemas/marketing';


export const GET = route({
  auth: 'tenant', capability: ['marketing.view', 'marketing.manage', 'campaigns.approve'], feature: 'feature.campaigns',
  handler: async ({ tenant, params }) => ({ data: await getCampaign(tenant, requireUuidParam(params, 'id')) }),
});

export const PATCH = route({
  auth: 'tenant', capability: 'marketing.manage', feature: 'feature.campaigns', input: campaignPatch,
  handler: async ({ tenant, actor, params, input }) => ({ data: await updateCampaign(tenant, actor, requireUuidParam(params, 'id'), input) }),
});
