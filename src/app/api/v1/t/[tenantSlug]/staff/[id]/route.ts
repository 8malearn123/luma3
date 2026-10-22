import { route } from '@/server/http/route';
import { updateStaff } from '@/server/domains/team/service';
import { staffPatch } from '@/shared/schemas/team';
import { requireUuidParam } from '@/server/http/params';

export const PATCH = route({
  auth: 'tenant', capability: 'staff.edit', input: staffPatch,
  handler: async ({ tenant, actor, input, params }) => ({ data: await updateStaff(tenant, actor, requireUuidParam(params, 'id'), input) }),
});
