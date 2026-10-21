import { route } from '@/server/http/route';
import { createMaterial, listItems } from '@/server/domains/commerce/inventory';
import { inventoryItemInput, inventoryListQuery } from '@/shared/schemas/commerce';

export const GET = route({
  auth: 'tenant', capability: ['inventory.view', 'inventory.manage'], feature: 'feature.inventory', input: inventoryListQuery,
  handler: async ({ tenant, input }) => ({ data: await listItems(tenant, input) }),
});

export const POST = route({
  auth: 'tenant', capability: 'inventory.manage', feature: 'feature.inventory', input: inventoryItemInput,
  handler: async ({ tenant, actor, input }) => ({ status: 201, data: await createMaterial(tenant, actor, input) }),
});
