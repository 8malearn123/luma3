import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { applyCount } from '@/server/domains/commerce/counts';
import { stockCountApplyInput } from '@/shared/schemas/commerce';

/** Applies the count once: differences become adjustment movements; large ones notify. */
export const POST = route({
  auth: 'tenant', capability: 'inventory.manage', feature: 'feature.inventory', input: stockCountApplyInput,
  handler: async ({ tenant, actor, input, params }) => ({ data: await applyCount(tenant, actor, requireUuidParam(params, 'id'), input.version) }),
});
