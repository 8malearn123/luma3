import { route } from '@/server/http/route';
import { listBalances } from '@/server/domains/commerce/locations';
import { balancesQuery } from '@/shared/schemas/inventory';

/** Balance by item × location (value at weighted average with costs.view). */
export const GET = route({
  auth: 'tenant', capability: ['inventory.view', 'inventory.manage'], feature: 'feature.inventory', input: balancesQuery,
  handler: async ({ tenant, input }) => ({ data: await listBalances(tenant, input) }),
});
