import { z } from 'zod';
import { route } from '@/server/http/route';
import { listMyBookings } from '@/server/domains/customers/account';

/** GET — the customer's own bookings across every business. */
export const GET = route({
  auth: 'user', input: z.object({ scope: z.enum(['upcoming', 'past', 'all']).default('all') }),
  handler: async ({ user, input }) => ({ data: await listMyBookings(user, input.scope) }),
});
