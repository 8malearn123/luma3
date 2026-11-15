import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { reviewSpace } from '@/server/domains/hosting/bookings';
import { reviewInput } from '@/shared/schemas/hosting';
/** D9: the expert rates the space after a completed booking. */
export const POST = route({
  auth: 'tenant', capability: 'workspace.book', feature: 'workspace.book', input: reviewInput,
  handler: async ({ tenant, actor, params, input }) => ({ data: await reviewSpace(tenant, actor, requireUuidParam(params, 'id'), input) }),
});
