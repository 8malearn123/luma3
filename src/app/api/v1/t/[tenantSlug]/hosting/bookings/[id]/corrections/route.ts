import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { addCorrection } from '@/server/domains/hosting/bookings';
import { correctionInput } from '@/shared/schemas/hosting';
export const POST = route({
  auth: 'tenant', capability: 'hosting.manage', input: correctionInput,
  handler: async ({ tenant, actor, params, input }) => ({ data: await addCorrection(tenant, actor, requireUuidParam(params, 'id'), input) }),
});
