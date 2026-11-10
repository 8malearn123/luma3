import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { reverseMovement } from '@/server/domains/commerce/inventory';
import { reverseInput } from '@/shared/schemas/inventory';

/** Movements are never edited: a correction movement reverses one (once), at its frozen cost. */
export const POST = route({
  auth: 'tenant', capability: 'inventory.manage', feature: 'feature.inventory', input: reverseInput,
  handler: async ({ tenant, actor, input, params }) => ({ status: 201, data: await reverseMovement(tenant, actor, requireUuidParam(params, 'id'), input.reason) }),
});
