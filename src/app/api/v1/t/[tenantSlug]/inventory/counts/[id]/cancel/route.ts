import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { cancelCount } from '@/server/domains/commerce/counts';

export const POST = route({
  auth: 'tenant', capability: 'inventory.manage', feature: 'feature.inventory',
  handler: async ({ tenant, actor, params }) => ({ data: await cancelCount(tenant, actor, requireUuidParam(params, 'id')) }),
});
