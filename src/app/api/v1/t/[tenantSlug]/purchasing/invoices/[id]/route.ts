import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { getInvoice } from '@/server/domains/commerce/purchasing';

export const GET = route({
  auth: 'tenant', capability: ['purchasing.manage', 'purchasing.pay', 'finance.view'], feature: 'feature.purchasing',
  handler: async ({ tenant, params }) => ({ data: await getInvoice(tenant, requireUuidParam(params, 'id')) }),
});
