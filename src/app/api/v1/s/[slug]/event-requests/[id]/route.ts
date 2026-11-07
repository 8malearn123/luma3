import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { publicTenant } from '@/server/domains/storefront-public';
import { getMyEventBooking } from '@/server/domains/events/service';

/** GET my event request with its quote (owner only; others get 404). */
export const GET = route({
  auth: 'user',
  handler: async ({ params, user }) => {
    const t = await publicTenant(params.slug!);
    return { data: await getMyEventBooking(t.id, user.userId, requireUuidParam(params, 'id')) };
  },
});
