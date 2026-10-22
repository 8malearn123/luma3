import { route } from '@/server/http/route';
import { createVariant } from '@/server/domains/catalog/service';
import { variantInput } from '@/shared/schemas/catalog';
import { requireUuidParam } from '@/server/http/params';

export const POST = route({
  auth: 'tenant', capability: 'catalog.edit', input: variantInput,
  handler: async ({ tenant, actor, input, params }) => ({ status: 201, data: await createVariant(tenant, actor, requireUuidParam(params, 'id'), input) }),
});
