import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { updateTenantRule } from '@/server/domains/policy/service';
import { rulePatch } from '@/shared/schemas/policy';

export const PATCH = route({
  auth: 'tenant', capability: 'incidents.review', input: rulePatch,
  handler: async ({ tenant, actor, params, input }) => ({ data: await updateTenantRule(tenant, actor, requireUuidParam(params, 'id'), input) }),
});
