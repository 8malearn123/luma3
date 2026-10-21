import { route } from '@/server/http/route';
import { updateVariant } from '@/server/domains/catalog/service';
import { variantPatch } from '@/shared/schemas/catalog';
import { requireUuidParam } from '@/server/http/params';

export const PATCH = route({
  auth: 'tenant', capability: 'catalog.edit', input: variantPatch,
  handler: async ({ tenant, input, params }) => ({ data: await updateVariant(tenant, requireUuidParam(params, 'id'), input) }),
});
