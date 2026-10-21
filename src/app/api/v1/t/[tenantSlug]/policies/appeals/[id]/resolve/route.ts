import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { resolveTenantAppeal } from '@/server/domains/policy/service';
import { appealResolve } from '@/shared/schemas/policy';

export const POST = route({
  auth: 'tenant', capability: 'incidents.review', input: appealResolve, stepUp: true,
  handler: async ({ tenant, actor, params, input }) => ({ data: await resolveTenantAppeal(tenant, actor, requireUuidParam(params, 'id'), input) }),
});
