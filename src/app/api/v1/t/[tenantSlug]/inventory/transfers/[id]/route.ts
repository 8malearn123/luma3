import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { getTransfer } from '@/server/domains/commerce/transfers';

export const GET = route({
  auth: 'tenant', capability: ['inventory.view', 'inventory.manage', 'inventory.transfer'], feature: 'feature.inventory_transfers',
  handler: async ({ tenant, params }) => ({ data: await getTransfer(tenant, requireUuidParam(params, 'id')) }),
});
