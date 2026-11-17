import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { getReceipt } from '@/server/domains/commerce/purchasing';

export const GET = route({
  auth: 'tenant', capability: ['purchasing.view', 'purchasing.receive'], feature: 'feature.purchasing',
  handler: async ({ tenant, params }) => ({ data: await getReceipt(tenant, requireUuidParam(params, 'id')) }),
});
