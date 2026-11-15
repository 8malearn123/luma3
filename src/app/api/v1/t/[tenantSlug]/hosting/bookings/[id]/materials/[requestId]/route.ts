import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { decideMaterial } from '@/server/domains/hosting/bookings';
import { decisionInput } from '@/shared/schemas/hosting';
export const POST = route({
  auth: 'tenant', capability: 'hosting.manage', input: decisionInput,
  handler: async ({ tenant, actor, params, input }) => ({ data: await decideMaterial(tenant, actor, requireUuidParam(params, 'id'), requireUuidParam(params, 'requestId'), input) }),
});
