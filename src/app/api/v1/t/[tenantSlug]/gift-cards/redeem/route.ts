import { z } from 'zod';
import { route } from '@/server/http/route';
import { redeemGiftCard } from '@/server/domains/giftcards/service';

/** Counter redemption by staff against a booking/order balance. */
export const POST = route({
  auth: 'tenant', capability: 'payments.collect', feature: 'feature.gift_cards', idempotency: 'required',
  input: z.object({ code: z.string().min(8).max(40), booking_id: z.string().uuid().optional(), order_id: z.string().uuid().optional(), amount_minor: z.number().int().positive() }),
  handler: async ({ tenant, actor, input, idempotencyKey }) => {
    const r = await redeemGiftCard(tenant.tenantId, { code: input.code, bookingId: input.booking_id, orderId: input.order_id, amountMinor: input.amount_minor, actorUserId: actor.userId!, idempotencyKey: idempotencyKey!, rateKey: `staff:${actor.userId}` });
    return { status: r.status, data: r.body };
  },
});
