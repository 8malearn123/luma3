import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { getItem, updateItem } from '@/server/domains/commerce/inventory';
import { inventoryItemPatch } from '@/shared/schemas/commerce';

export const GET = route({
  auth: 'tenant', capability: ['inventory.view', 'inventory.manage'], feature: 'feature.inventory',
  handler: async ({ tenant, params }) => ({ data: await getItem(tenant, requireUuidParam(params, 'id')) }),
});

export const PATCH = route({
  auth: 'tenant', capability: 'inventory.manage', feature: 'feature.inventory', input: inventoryItemPatch,
  handler: async ({ tenant, actor, input, params }) => ({ data: await updateItem(tenant, actor, requireUuidParam(params, 'id'), input) }),
});
