import { route } from '@/server/http/route';
import { withTenant } from '@/server/db/client';
import { getCart } from '@/server/domains/commerce/cart';
import { cartIdentity, resolveShop } from '@/server/domains/commerce/cart-cookie';
import { shopPaymentPaths } from '@/server/domains/commerce/orders';

/**
 * The visitor's cart for this business: live prices/stock, changed-price and
 * availability flags, and the payment paths open right now (online / pay at
 * pickup / not accepting orders). Never costs.
 */
export const GET = route({
  auth: 'optional',
  handler: async ({ req, params, user }) => {
    const shop = await resolveShop(params.slug!);
    const cart = await getCart(shop.tenantId, cartIdentity(req, user));
    const payment = await withTenant(shop.tenantId, async (trx) => {
      const tc = user ? await trx.selectFrom('tenant_customers').select('id').where('user_id', '=', user.userId).executeTakeFirst() : undefined;
      return shopPaymentPaths(trx, shop.tenantId, { tenantCustomerId: tc?.id ?? null, userId: user?.userId ?? null });
    });
    return { data: { ...cart, payment, signed_in: !!user, verified: !!user && (user.emailVerified || user.phoneVerified) } };
  },
});
