import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { setRecipe } from '@/server/domains/commerce/inventory';
import { recipeInput } from '@/shared/schemas/commerce';

/** Replaces the service's consumption recipe; saving approves the consumption rate. */
export const PUT = route({
  auth: 'tenant', capability: 'inventory.manage', feature: 'feature.inventory', input: recipeInput,
  handler: async ({ tenant, actor, input, params }) => ({ data: await setRecipe(tenant, actor, requireUuidParam(params, 'serviceId'), input) }),
});
