import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { publicTenant } from '@/server/domains/storefront-public';
import { paymentStatusForPayer } from '@/server/domains/payments/service';

/** GET payment status (the return redirect is never treated as proof of payment). */
export const GET = route({
  auth: 'user',
  handler: async ({ params, user }) => {
    const t = await publicTenant(params.slug!);
    return { data: await paymentStatusForPayer(t.id, requireUuidParam(params, 'id'), user.userId) };
  },
});
