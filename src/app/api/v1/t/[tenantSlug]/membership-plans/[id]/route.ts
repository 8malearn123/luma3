import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { planPatch, updatePlan } from '@/server/domains/memberships/service';

/** PATCH edit a plan for future sales, or (de)activate / hide it. Sold memberships keep their snapshot. */
export const PATCH = route({
  auth: 'tenant', capability: 'memberships.manage', feature: 'feature.memberships', input: planPatch,
  handler: async ({ tenant, actor, params, input }) => ({ data: await updatePlan(tenant, actor, requireUuidParam(params, 'id'), input) }),
});
