import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { updateLocation } from '@/server/domains/commerce/locations';
import { locationPatch } from '@/shared/schemas/inventory';

export const PATCH = route({
  auth: 'tenant', capability: 'inventory.manage', feature: 'feature.inventory', input: locationPatch,
  handler: async ({ tenant, actor, input, params }) => ({ data: await updateLocation(tenant, actor, requireUuidParam(params, 'id'), input) }),
});
