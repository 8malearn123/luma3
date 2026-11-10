import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { requestMaterial } from '@/server/domains/hosting/bookings';
import { materialRequestInput } from '@/shared/schemas/hosting';
export const POST = route({
  auth: 'tenant', capability: 'workspace.book', feature: 'workspace.book', input: materialRequestInput,
  handler: async ({ tenant, actor, params, input }) => ({ data: await requestMaterial(tenant, actor, requireUuidParam(params, 'id'), input) }),
});
