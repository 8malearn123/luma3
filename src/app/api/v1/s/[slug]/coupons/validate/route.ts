import { z } from 'zod';
import { route } from '@/server/http/route';
import { previewCoupon } from '@/server/domains/commerce/cart';
import { cartIdentity, resolveShop } from '@/server/domains/commerce/cart-cookie';

/** Previews a coupon against the signed-in customer's current cart subtotal (nothing is redeemed). */
export const POST = route({
  auth: 'user', input: z.object({ code: z.string().trim().min(3).max(40) }),
  rateLimit: { scope: 'user', limit: 30, windowSec: 600, name: 'coupon_preview' },
  handler: async ({ req, params, user, input }) => {
    const shop = await resolveShop(params.slug!);
    return { data: await previewCoupon(shop.tenantId, { userId: user.userId }, cartIdentity(req, user), input.code) };
  },
});
