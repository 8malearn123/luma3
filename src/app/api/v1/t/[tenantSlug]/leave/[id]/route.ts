import { route } from '@/server/http/route';
import { decideLeave } from '@/server/domains/schedule/service';
import { leaveDecision } from '@/shared/schemas/team';
import { requireUuidParam } from '@/server/http/params';

export const POST = route({
  auth: 'tenant', capability: 'leave.approve', input: leaveDecision,
  handler: async ({ tenant, actor, params, input }) => ({ data: await decideLeave(tenant, actor, requireUuidParam(params, 'id'), input) }),
});
