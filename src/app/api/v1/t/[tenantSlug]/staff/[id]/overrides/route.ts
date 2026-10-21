import { route } from '@/server/http/route';
import { addOverride } from '@/server/domains/schedule/service';
import { overrideInput } from '@/shared/schemas/team';
import { requireUuidParam } from '@/server/http/params';

export const POST = route({
  auth: 'tenant', capability: 'schedule.manage', input: overrideInput,
  handler: async ({ tenant, actor, params, input }) => ({ status: 201, data: await addOverride(tenant, actor, requireUuidParam(params, 'id'), input) }),
});
