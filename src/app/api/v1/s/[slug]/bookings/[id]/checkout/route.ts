import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { publicTenant } from '@/server/domains/storefront-public';
import { checkoutBooking } from '@/server/domains/payments/service';
import { checkoutInput } from '@/shared/schemas/booking';

/** POST choose how to pay; amounts and allowed options are computed server-side. */
export const POST = route({
  auth: 'user',
  requireVerified: true,
  idempotency: 'required',
  input: checkoutInput,
  handler: async ({ params, input, user, actor, idempotencyKey }) => {
    const t = await publicTenant(params.slug!);
    const id = requireUuidParam(params, 'id');
    const r = await checkoutBooking(t.id, id, { option: input.option, userId: user.userId, idempotencyKey: idempotencyKey!, returnUrl: `/s/${t.slug}/checkout/booking/${id}`, actor: { ...actor, kind: 'customer' } });
    return { status: r.status, data: r.body };
  },
});
