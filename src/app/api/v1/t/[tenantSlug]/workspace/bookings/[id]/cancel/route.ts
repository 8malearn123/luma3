import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { cancelSpace } from '@/server/domains/hosting/bookings';
import { reasonInput } from '@/shared/schemas/hosting';
/** Cancels the SPACE booking under its saved terms. Her client appointments are not touched (D10). */
export const POST = route({
  auth: 'tenant', capability: 'workspace.book', feature: 'workspace.book', input: reasonInput,
  handler: async ({ tenant, actor, params, input }) => ({ data: await cancelSpace(tenant, actor, requireUuidParam(params, 'id'), input.reason) }),
});
