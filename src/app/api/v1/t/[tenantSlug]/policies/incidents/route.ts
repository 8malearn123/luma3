import { route } from '@/server/http/route';
import { hasCapability } from '@/server/tenancy/access';
import { createIncident, listIncidents } from '@/server/domains/policy/incidents';
import { incidentCreate, incidentListQuery } from '@/shared/schemas/policy';

/** GET — reviewers see all incidents; submit-only members see their own reports. */
export const GET = route({
  auth: 'tenant', capability: ['incidents.review', 'incidents.submit'], input: incidentListQuery,
  handler: async ({ tenant, user, input }) => ({
    data: await listIncidents(tenant, input, hasCapability(tenant, 'incidents.review') ? undefined : user.userId),
  }),
});

export const POST = route({
  auth: 'tenant', capability: 'incidents.submit', input: incidentCreate, idempotency: 'optional',
  handler: async ({ tenant, actor, input }) => ({ status: 201, data: await createIncident(tenant, actor, input) }),
});
