import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { markNoShow } from '@/server/domains/hosting/bookings';

export const POST = route({
  auth: 'tenant', capability: 'hosting.manage',
  handler: async ({ tenant, actor, params }) => ({ data: await markNoShow(tenant, actor, requireUuidParam(params, 'id')) }),
});
