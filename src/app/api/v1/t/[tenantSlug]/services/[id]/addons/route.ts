import { route } from '@/server/http/route';
import { createAddon } from '@/server/domains/catalog/service';
import { addonInput } from '@/shared/schemas/catalog';
import { requireUuidParam } from '@/server/http/params';

export const POST = route({
  auth: 'tenant', capability: 'catalog.edit', input: addonInput,
  handler: async ({ tenant, actor, input, params }) => ({ status: 201, data: await createAddon(tenant, actor, requireUuidParam(params, 'id'), input) }),
});
