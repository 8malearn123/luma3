import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { decideRequest } from '@/server/domains/hosting/bookings';
import { decisionInput } from '@/shared/schemas/hosting';
/** Approve or reject a request within its 2-hour window (D1, D1c). */
export const POST = route({
  auth: 'tenant', capability: 'hosting.manage', input: decisionInput,
  handler: async ({ tenant, actor, params, input }) => ({ data: await decideRequest(tenant, actor, requireUuidParam(params, 'id'), input) }),
});
