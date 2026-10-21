import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { getPlan } from '@/server/domains/marketing/plans';


export const GET = route({
  auth: 'tenant', capability: ['marketing.view', 'marketing.manage'], feature: 'feature.marketing_ai',
  handler: async ({ tenant, params }) => ({ data: await getPlan(tenant, requireUuidParam(params, 'id')) }),
});
