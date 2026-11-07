import { z } from 'zod';
import { route } from '@/server/http/route';
import { listEventBookings } from '@/server/domains/events/service';
import { EVENT_STATUSES } from '@/shared/schemas/events';

/** GET event bookings («حجوزات المناسبات»): requests, quotes and confirmed events. */
export const GET = route({
  auth: 'tenant', capability: ['bookings.view_all', 'bookings.manage'],
  input: z.object({ status: z.string().max(200).optional() }),
  handler: async ({ tenant, input }) => {
    const status = input.status?.split(',').filter((s) => (EVENT_STATUSES as readonly string[]).includes(s));
    return { data: await listEventBookings(tenant, { status }) };
  },
});
