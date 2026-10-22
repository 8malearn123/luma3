import { route } from '@/server/http/route';
import { recordOnSitePayment } from '@/server/domains/payments/service';
import { onSitePaymentInput } from '@/shared/schemas/booking';

/** POST cash/terminal collection — requires payments.collect, collector identity and a reference. */
export const POST = route({
  auth: 'tenant', capability: 'payments.collect', idempotency: 'required', input: onSitePaymentInput,
  handler: async ({ tenant, input, actor, idempotencyKey }) => {
    const r = await recordOnSitePayment(tenant, actor, { bookingId: input.booking_id, orderId: input.order_id, amountMinor: input.amount_minor, method: input.method, reference: input.reference, idempotencyKey: idempotencyKey! });
    return { status: r.status, data: r.body };
  },
});
