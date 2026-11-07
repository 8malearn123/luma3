import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { getEventBooking } from '@/server/domains/events/service';

export const GET = route({
  auth: 'tenant', capability: ['bookings.view_all', 'bookings.manage'],
  handler: async ({ tenant, params }) => ({ data: await getEventBooking(tenant, requireUuidParam(params, 'id')) }),
});
