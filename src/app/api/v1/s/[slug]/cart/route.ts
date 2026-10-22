import { route } from '@/server/http/route';
import { getCart } from '@/server/domains/commerce/cart';
import { cartIdentity, resolveShop } from '@/server/domains/commerce/cart-cookie';

/** The visitor's cart for this business: live prices/stock, changed-price and availability flags. Never costs. */
export const GET = route({
  auth: 'optional',
  handler: async ({ req, params, user }) => {
    const shop = await resolveShop(params.slug!);
    const cart = await getCart(shop.tenantId, cartIdentity(req, user));
    return { data: { ...cart, signed_in: !!user, verified: !!user && (user.emailVerified || user.phoneVerified) } };
  },
});
