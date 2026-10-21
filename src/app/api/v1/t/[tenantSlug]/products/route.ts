import { route } from '@/server/http/route';
import { createProduct, listProducts } from '@/server/domains/commerce/products';
import { productInput, productListQuery } from '@/shared/schemas/commerce';

export const GET = route({
  auth: 'tenant', capability: ['catalog.edit', 'inventory.manage', 'inventory.view', 'orders.manage'], feature: 'feature.products', input: productListQuery,
  handler: async ({ tenant, input }) => ({ data: await listProducts(tenant, input) }),
});

/** Plan limit limit.products is enforced inside the creating transaction. */
export const POST = route({
  auth: 'tenant', capability: 'catalog.edit', feature: 'feature.products', input: productInput,
  handler: async ({ tenant, actor, input }) => ({ status: 201, data: await createProduct(tenant, actor, input) }),
});
