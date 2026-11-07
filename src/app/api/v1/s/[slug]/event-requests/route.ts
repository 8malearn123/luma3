import { route } from '@/server/http/route';
import { publicTenant } from '@/server/domains/storefront-public';
import { createEventRequest, listMyEventBookings } from '@/server/domains/events/service';
import { eventRequestInput } from '@/shared/schemas/events';

/** GET my event requests at this business; POST a new request (date, time, location, people, services, notes). */
export const GET = route({
  auth: 'user',
  handler: async ({ params, user }) => {
    const t = await publicTenant(params.slug!);
    return { data: await listMyEventBookings(t.id, user.userId) };
  },
});
export const POST = route({
  auth: 'user', requireVerified: true, idempotency: 'required', input: eventRequestInput,
  rateLimit: { scope: 'user', name: 'event_request', limit: 10, windowSec: 3600 },
  handler: async ({ params, user, input, actor, idempotencyKey }) => {
    const t = await publicTenant(params.slug!);
    const r = await createEventRequest(t.id, user, input, idempotencyKey!, { ...actor, kind: 'customer' });
    return { status: r.status, data: r.body };
  },
});
