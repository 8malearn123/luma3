import { route } from '@/server/http/route';
import { addToCart, ensureAnonToken } from '@/server/domains/commerce/cart';
import { cartCookie, cartIdentity, resolveShop } from '@/server/domains/commerce/cart-cookie';
import { cartAddInput } from '@/shared/schemas/commerce';

/** Adds (or merges into the existing line). Any client-sent price is stripped by the schema and never used. */
export const POST = route({
  auth: 'optional', input: cartAddInput,
  rateLimit: { scope: 'ip', limit: 120, windowSec: 60, name: 'cart' },
  handler: async ({ req, params, user, input, responseInit }) => {
    const shop = await resolveShop(params.slug!);
    const { ident, issued } = ensureAnonToken(cartIdentity(req, user));
    const cart = await addToCart(shop.tenantId, ident, input);
    if (issued) responseInit.cookies.push(cartCookie(issued));
    return { status: 201, data: cart };
  },
});
