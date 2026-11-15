import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { resolveTask } from '@/server/domains/commerce/inventory-tasks';
import { taskResolveInput } from '@/shared/schemas/inventory';

/** Shortage: post the remaining quantity or write it off (reason). Others: resolve or dismiss. */
export const POST = route({
  auth: 'tenant', capability: 'inventory.manage', feature: 'feature.inventory', input: taskResolveInput,
  handler: async ({ tenant, actor, input, params }) => ({ data: await resolveTask(tenant, actor, requireUuidParam(params, 'id'), input.action, input.resolution) }),
});
