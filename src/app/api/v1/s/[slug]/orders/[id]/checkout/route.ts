import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { publicTenant } from '@/server/domains/storefront-public';
import { checkoutOrder } from '@/server/domains/payments/service';

/** POST pay a pending order online (full amount computed server-side). */
export const POST = route({
  auth: 'user',
  requireVerified: true,
  idempotency: 'required',
  handler: async ({ params, user, actor, idempotencyKey }) => {
    const t = await publicTenant(params.slug!);
    const id = requireUuidParam(params, 'id');
    const r = await checkoutOrder(t.id, id, { userId: user.userId, idempotencyKey: idempotencyKey!, returnUrl: `/s/${t.slug}/checkout/order/${id}`, actor: { ...actor, kind: 'customer' } });
    return { status: r.status, data: r.body };
  },
});
