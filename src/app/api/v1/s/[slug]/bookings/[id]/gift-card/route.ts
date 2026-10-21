import { z } from 'zod';
import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { redeemGiftCard } from '@/server/domains/giftcards/service';
import { publicTenant, requirePublicFeature } from '@/server/domains/storefront-public';

/** Customer applies a gift card to her own booking balance (partial redemption allowed). */
export const POST = route({
  auth: 'user', requireVerified: true, idempotency: 'required', input: z.object({ code: z.string().min(8).max(40), amount_minor: z.number().int().positive() }),
  handler: async ({ params, input, user, idempotencyKey }) => {
    const t = await publicTenant(params.slug!);
    await requirePublicFeature(t.id, 'feature.gift_cards');
    const r = await redeemGiftCard(t.id, { code: input.code, bookingId: requireUuidParam(params, 'id'), amountMinor: input.amount_minor, actorUserId: user.userId, payerUserId: user.userId, idempotencyKey: idempotencyKey!, rateKey: `u:${user.userId}` });
    return { status: r.status, data: r.body };
  },
});
