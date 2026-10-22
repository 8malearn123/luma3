import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { transitionIncident } from '@/server/domains/policy/incidents';
import { incidentTransition } from '@/shared/schemas/policy';

/** POST — confirm / reject / correct / start review, with a mandatory note. */
export const POST = route({
  auth: 'tenant', capability: 'incidents.review', input: incidentTransition,
  handler: async ({ tenant, actor, params, input }) => ({ data: await transitionIncident(tenant, actor, requireUuidParam(params, 'id'), input) }),
});
