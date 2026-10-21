import { route } from '@/server/http/route';
import { capacityEstimates } from '@/server/domains/commerce/inventory';

export const GET = route({
  auth: 'tenant', capability: ['inventory.view', 'inventory.manage'], feature: 'feature.inventory',
  handler: async ({ tenant }) => ({ data: await capacityEstimates(tenant) }),
});
