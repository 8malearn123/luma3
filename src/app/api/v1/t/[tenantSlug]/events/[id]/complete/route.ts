import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { completeEvent } from '@/server/domains/events/service';

export const POST = route({
  auth: 'tenant', capability: 'bookings.manage',
  handler: async ({ tenant, actor, params }) => ({ data: await completeEvent(tenant, actor, requireUuidParam(params, 'id')) }),
});
