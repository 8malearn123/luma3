import { route } from '@/server/http/route';
import { createMaterial, listItems } from '@/server/domains/commerce/inventory';
import { branchScopeFor } from '@/server/domains/business/branch-scope';
import { inventoryItemInput, inventoryListQuery } from '@/shared/schemas/commerce';

export const GET = route({
  auth: 'tenant', capability: ['inventory.view', 'inventory.manage'], feature: 'feature.inventory', input: inventoryListQuery,
  handler: async ({ tenant, input, req }) => ({ data: await listItems(tenant, input, { branchIds: (await branchScopeFor(req, tenant)).branchIds }) }),
});

export const POST = route({
  auth: 'tenant', capability: 'inventory.manage', feature: 'feature.inventory', input: inventoryItemInput,
  handler: async ({ tenant, actor, input }) => ({ status: 201, data: await createMaterial(tenant, actor, input) }),
});
