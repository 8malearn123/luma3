import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { getTenantDecision } from '@/server/domains/policy/service';

export const GET = route({
  auth: 'tenant', capability: 'incidents.review',
  handler: async ({ tenant, params }) => ({ data: await getTenantDecision(tenant, requireUuidParam(params, 'id')) }),
});
