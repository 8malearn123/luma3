import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { updateSupplier } from '@/server/domains/commerce/purchasing';
import { supplierPatch } from '@/shared/schemas/inventory';

export const PATCH = route({
  auth: 'tenant', capability: ['purchasing.manage', 'inventory.manage'], feature: 'feature.inventory', input: supplierPatch,
  handler: async ({ tenant, actor, input, params }) => ({ data: await updateSupplier(tenant, actor, requireUuidParam(params, 'id'), input) }),
});
