import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { getProduct, updateProduct } from '@/server/domains/commerce/products';
import { productPatch } from '@/shared/schemas/commerce';

export const GET = route({
  auth: 'tenant', capability: ['catalog.edit', 'inventory.manage', 'inventory.view', 'orders.manage'], feature: 'feature.products',
  handler: async ({ tenant, params }) => ({ data: await getProduct(tenant, requireUuidParam(params, 'id')) }),
});

/** PATCH with { version }: 409 version_conflict on concurrent edits. */
export const PATCH = route({
  auth: 'tenant', capability: 'catalog.edit', feature: 'feature.products', input: productPatch,
  handler: async ({ tenant, actor, input, params }) => ({ data: await updateProduct(tenant, actor, requireUuidParam(params, 'id'), input) }),
});
