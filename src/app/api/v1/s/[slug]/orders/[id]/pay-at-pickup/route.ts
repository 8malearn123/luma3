import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { publicTenant } from '@/server/domains/storefront-public';
import { choosePayAtPickup } from '@/server/domains/commerce';

/** POST switch a pending order to pay at pickup (only when the business allows paying on site for this customer). */
export const POST = route({
  auth: 'user',
  requireVerified: true,
  handler: async ({ params, user }) => {
    const t = await publicTenant(params.slug!);
    return { data: await choosePayAtPickup(t.id, user.userId, requireUuidParam(params, 'id')) };
  },
});
