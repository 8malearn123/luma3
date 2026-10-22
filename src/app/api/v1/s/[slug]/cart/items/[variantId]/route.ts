import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { removeFromCart, setCartQuantity } from '@/server/domains/commerce/cart';
import { cartIdentity, resolveShop } from '@/server/domains/commerce/cart-cookie';
import { cartQtyInput } from '@/shared/schemas/commerce';

export const PATCH = route({
  auth: 'optional', input: cartQtyInput,
  rateLimit: { scope: 'ip', limit: 120, windowSec: 60, name: 'cart' },
  handler: async ({ req, params, user, input }) => {
    const shop = await resolveShop(params.slug!);
    return { data: await setCartQuantity(shop.tenantId, cartIdentity(req, user), requireUuidParam(params, 'variantId'), input.quantity) };
  },
});

export const DELETE = route({
  auth: 'optional',
  handler: async ({ req, params, user }) => {
    const shop = await resolveShop(params.slug!);
    return { data: await removeFromCart(shop.tenantId, cartIdentity(req, user), requireUuidParam(params, 'variantId')) };
  },
});
