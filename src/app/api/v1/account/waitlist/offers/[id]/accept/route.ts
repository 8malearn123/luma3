import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { acceptOffer } from '@/server/domains/waitlist/service';

/** POST accept a waitlist offer → atomic hold (then the normal checkout). */
export const POST = route({
  auth: 'user', requireVerified: true, idempotency: 'required',
  handler: async ({ params, user, actor, idempotencyKey }) => ({ status: 201, data: await acceptOffer(user, requireUuidParam(params, 'id'), idempotencyKey!, { ...actor, kind: 'customer' }) }),
});
