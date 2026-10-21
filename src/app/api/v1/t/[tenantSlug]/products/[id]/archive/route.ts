import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { archiveProduct } from '@/server/domains/commerce/products';
import { archiveInput } from '@/shared/schemas/commerce';

/** Archive (never delete) or restore; restoring re-checks limit.products. */
export const POST = route({
  auth: 'tenant', capability: 'catalog.edit', feature: 'feature.products', input: archiveInput,
  handler: async ({ tenant, actor, input, params }) => ({ data: await archiveProduct(tenant, actor, requireUuidParam(params, 'id'), input.archived) }),
});
