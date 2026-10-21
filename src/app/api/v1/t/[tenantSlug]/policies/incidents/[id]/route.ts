import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { hasCapability } from '@/server/tenancy/access';
import { getIncident } from '@/server/domains/policy/incidents';

export const GET = route({
  auth: 'tenant', capability: ['incidents.review', 'incidents.submit'],
  handler: async ({ tenant, user, params }) => ({
    data: await getIncident(tenant, requireUuidParam(params, 'id'), hasCapability(tenant, 'incidents.review') ? undefined : user.userId),
  }),
});
