import { route } from '@/server/http/route';
import { updateAddon } from '@/server/domains/catalog/service';
import { addonPatch } from '@/shared/schemas/catalog';
import { requireUuidParam } from '@/server/http/params';

export const PATCH = route({
  auth: 'tenant', capability: 'catalog.edit', input: addonPatch,
  handler: async ({ tenant, input, params }) => ({ data: await updateAddon(tenant, requireUuidParam(params, 'id'), input) }),
});
