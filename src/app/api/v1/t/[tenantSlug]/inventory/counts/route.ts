import { route } from '@/server/http/route';
import { createCount, listCounts } from '@/server/domains/commerce/counts';
import { stockCountInput } from '@/shared/schemas/commerce';

/** Physical stock counts (newest first). */
export const GET = route({
  auth: 'tenant', capability: ['inventory.view', 'inventory.manage'], feature: 'feature.inventory',
  handler: async ({ tenant }) => ({ data: await listCounts(tenant) }),
});

/** Opens a draft count listing every active item of the branch (one open count per branch). */
export const POST = route({
  auth: 'tenant', capability: 'inventory.manage', feature: 'feature.inventory', input: stockCountInput,
  handler: async ({ tenant, actor, input }) => ({ status: 201, data: await createCount(tenant, actor, input) }),
});
