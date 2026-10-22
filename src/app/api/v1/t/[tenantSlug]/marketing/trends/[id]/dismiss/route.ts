import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { dismissTrend } from '@/server/domains/marketing/trends';


export const POST = route({
  auth: 'tenant', capability: 'marketing.manage', feature: 'feature.marketing_ai',
  handler: async ({ tenant, actor, params }) => ({ data: await dismissTrend(tenant, actor, requireUuidParam(params, 'id')) }),
});
