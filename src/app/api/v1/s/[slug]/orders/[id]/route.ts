import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { getCustomerOrder } from '@/server/domains/commerce/orders';
import { resolveStorefront } from '@/server/domains/commerce/storefront';

/** The signed-in customer's own order at this business (for the checkout/payment page). */
export const GET = route({
  auth: 'user',
  handler: async ({ params, user }) => {
    const shop = await resolveStorefront(params.slug!);
    return { data: await getCustomerOrder(shop.tenantId, user.userId, requireUuidParam(params, 'id')) };
  },
});
