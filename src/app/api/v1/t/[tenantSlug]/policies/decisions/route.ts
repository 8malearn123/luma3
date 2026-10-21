import { route } from '@/server/http/route';
import { createTenantDecision, listTenantDecisions } from '@/server/domains/policy/service';
import { decisionListQuery, tenantDecisionCreate } from '@/shared/schemas/policy';

export const GET = route({
  auth: 'tenant', capability: 'incidents.review', input: decisionListQuery,
  handler: async ({ tenant, input }) => ({ data: await listTenantDecisions(tenant, input) }),
});

/** POST — tenant-scope decision by an authorised human reviewer (step-up). Platform scope is impossible here. */
export const POST = route({
  auth: 'tenant', capability: 'incidents.review', input: tenantDecisionCreate, stepUp: true, idempotency: 'optional',
  handler: async ({ tenant, actor, input }) => ({ status: 201, data: await createTenantDecision(tenant, actor, input) }),
});
