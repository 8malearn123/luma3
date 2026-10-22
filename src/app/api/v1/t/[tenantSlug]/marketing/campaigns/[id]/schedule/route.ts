import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { scheduleCampaign } from '@/server/domains/marketing/campaigns';
import { campaignScheduleInput } from '@/shared/schemas/marketing';


/** Starting a campaign needs campaigns.approve, a prior approval and a connected (or dev-simulated) channel. */
export const POST = route({
  auth: 'tenant', capability: 'campaigns.approve', feature: 'feature.campaigns', input: campaignScheduleInput,
  handler: async ({ tenant, actor, params, input }) => ({ data: await scheduleCampaign(tenant, actor, requireUuidParam(params, 'id'), input.scheduled_at ? new Date(input.scheduled_at) : undefined) }),
});
