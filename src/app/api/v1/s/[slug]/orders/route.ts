import { route } from '@/server/http/route';
import { createOrderFromCart } from '@/server/domains/commerce/orders';
import { cartIdentity, resolveShop } from '@/server/domains/commerce/cart-cookie';
import { checkoutInput } from '@/shared/schemas/commerce';
import { attachConversionSession, sessionFromRequest } from '@/server/domains/analytics/events';

/**
 * Checkout: creates a pending_payment order from the signed-in, verified
 * customer's cart (Idempotency-Key required; same key -> same order) and
 * returns the path of the payment page.
 */
export const POST = route({
  auth: 'user', requireVerified: true, idempotency: 'required', input: checkoutInput,
  rateLimit: { scope: 'user', limit: 20, windowSec: 600, name: 'checkout' },
  handler: async ({ req, params, user, input, idempotencyKey, actor }) => {
    const shop = await resolveShop(params.slug!);
    const ident = cartIdentity(req, user);
    const r = await createOrderFromCart({
      tenantId: shop.tenantId, user: { userId: user.userId, displayName: user.displayName, phone: user.phone, email: user.email },
      input, idempotencyKey: idempotencyKey!, actor: { ...actor, kind: 'customer' }, anonToken: ident.anonToken,
    });
    if (!r.replayed) await attachConversionSession(shop.tenantId, 'orders', r.order.id, sessionFromRequest(req));
    return { status: 201, data: { ...r.order, replayed: r.replayed } };
  },
});
