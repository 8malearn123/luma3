import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { cancelSpace } from '@/server/domains/hosting/bookings';
import { reasonInput } from '@/shared/schemas/hosting';
/** Host cancellation: full refund to the expert. */
export const POST = route({
  auth: 'tenant', capability: 'hosting.manage', input: reasonInput,
  handler: async ({ tenant, actor, params, input }) => ({ data: await cancelSpace(tenant, actor, requireUuidParam(params, 'id'), input.reason) }),
});
