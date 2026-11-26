import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { decideLateFee } from '@/server/domains/hosting/bookings';
import { decisionInput } from '@/shared/schemas/hosting';
/** D8: a proposed late fee enters the settlement only after the salon approves it. */
export const POST = route({
  auth: 'tenant', capability: 'hosting.manage', input: decisionInput,
  handler: async ({ tenant, actor, params, input }) => ({ data: await decideLateFee(tenant, actor, requireUuidParam(params, 'id'), requireUuidParam(params, 'lineId'), input) }),
});
