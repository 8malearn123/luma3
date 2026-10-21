import { route } from '@/server/http/route';
import { createCampaign, listCampaigns } from '@/server/domains/marketing/campaigns';
import { campaignInput } from '@/shared/schemas/marketing';


export const GET = route({
  auth: 'tenant', capability: ['marketing.view', 'marketing.manage', 'campaigns.approve'], feature: 'feature.campaigns',
  handler: async ({ tenant }) => ({ data: await listCampaigns(tenant) }),
});

export const POST = route({
  auth: 'tenant', capability: 'marketing.manage', feature: 'feature.campaigns', input: campaignInput,
  handler: async ({ tenant, actor, input }) => ({ status: 201, data: await createCampaign(tenant, actor, input) }),
});
