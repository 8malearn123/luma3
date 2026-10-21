import { route } from '@/server/http/route';
import { listRecipes } from '@/server/domains/commerce/inventory';

export const GET = route({
  auth: 'tenant', capability: ['inventory.view', 'inventory.manage'], feature: 'feature.inventory',
  handler: async ({ tenant }) => ({ data: await listRecipes(tenant) }),
});
