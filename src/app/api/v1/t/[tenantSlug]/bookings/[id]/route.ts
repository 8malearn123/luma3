import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { getBooking } from '@/server/domains/booking/service';
import { actionsFor, type BookingStatus } from '@/server/domains/booking/transitions';

export const GET = route({
  auth: 'tenant', capability: ['bookings.view_all', 'bookings.view_assigned', 'bookings.view_financial'],
  handler: async ({ tenant, params }) => {
    const b = await getBooking(tenant, requireUuidParam(params, 'id'));
    return { data: { ...b, available_actions: actionsFor(b.status as BookingStatus) } };
  },
});
