import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { decideRequest, decideRequestInput } from '@/server/domains/hr/requests';

/** POST approve or reject the current step (the role of the step, or the owner). */
export const POST = route({
  auth: 'tenant', input: decideRequestInput,
  handler: async ({ tenant, actor, params, input }) => ({ data: await decideRequest(tenant, actor, requireUuidParam(params, 'id'), input) }),
});
