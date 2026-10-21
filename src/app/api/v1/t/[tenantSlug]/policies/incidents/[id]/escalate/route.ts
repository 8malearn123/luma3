import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { escalateIncident } from '@/server/domains/policy/incidents';
import { incidentEscalate } from '@/shared/schemas/policy';

/** POST — sends a confirmed incident to LUMA review. Creates no decision by itself. */
export const POST = route({
  auth: 'tenant', capability: 'incidents.review', input: incidentEscalate, stepUp: true,
  handler: async ({ tenant, actor, params, input }) => ({ data: await escalateIncident(tenant, actor, requireUuidParam(params, 'id'), input) }),
});
