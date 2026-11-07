import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { publicTenant } from '@/server/domains/storefront-public';
import { cancelEvent } from '@/server/domains/events/service';
import { eventReasonInput } from '@/shared/schemas/events';

/** POST customer cancellation; refunds follow the policy captured with the quote. */
export const POST = route({
  auth: 'user', input: eventReasonInput,
  handler: async ({ params, user, input, actor }) => {
    const t = await publicTenant(params.slug!);
    const r = await cancelEvent(t.id, requireUuidParam(params, 'id'), { kind: 'customer', userId: user.userId, audit: { ...actor, kind: 'customer' } }, input.reason);
    return { data: { id: r.id, status: r.status, refund_minor: r.refund_minor, retained_minor: r.retained_minor, basis: r.basis } };
  },
});
