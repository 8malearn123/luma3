import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { endTenantDecision } from '@/server/domains/policy/service';
import { decisionEnd } from '@/shared/schemas/policy';

/** POST — revoke or expire an active tenant decision now (step-up). */
export const POST = route({
  auth: 'tenant', capability: 'incidents.review', input: decisionEnd, stepUp: true,
  handler: async ({ tenant, actor, params, input }) => ({ data: await endTenantDecision(tenant, actor, requireUuidParam(params, 'id'), input) }),
});
