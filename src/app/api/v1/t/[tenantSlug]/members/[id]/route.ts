import { route } from '@/server/http/route';
import { updateMembership } from '@/server/domains/team/service';
import { membershipPatch } from '@/shared/schemas/team';
import { requireUuidParam } from '@/server/http/params';

export const PATCH = route({
  auth: 'tenant', capability: 'team.manage', input: membershipPatch, stepUp: true,
  handler: async ({ tenant, actor, params, input }) => ({ data: await updateMembership(tenant, actor, requireUuidParam(params, 'id'), input) }),
});
