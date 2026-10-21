import { route } from '@/server/http/route';
import { acknowledgeCartPrices } from '@/server/domains/commerce/cart';
import { cartIdentity, resolveShop } from '@/server/domains/commerce/cart-cookie';

/** The customer accepts the current prices shown in the cart (required before checkout after a change). */
export const POST = route({
  auth: 'optional',
  handler: async ({ req, params, user }) => {
    const shop = await resolveShop(params.slug!);
    return { data: await acknowledgeCartPrices(shop.tenantId, cartIdentity(req, user)) };
  },
});
