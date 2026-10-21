import { route } from '@/server/http/route';
import { updateCategory } from '@/server/domains/catalog/service';
import { categoryPatch } from '@/shared/schemas/catalog';
import { requireUuidParam } from '@/server/http/params';

export const PATCH = route({
  auth: 'tenant', capability: 'catalog.edit', input: categoryPatch,
  handler: async ({ tenant, actor, input, params }) => ({ data: await updateCategory(tenant, actor, requireUuidParam(params, 'id'), input) }),
});
