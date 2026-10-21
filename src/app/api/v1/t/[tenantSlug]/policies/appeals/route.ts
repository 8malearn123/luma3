import { route } from '@/server/http/route';
import { listTenantAppeals } from '@/server/domains/policy/service';
import { appealListQuery } from '@/shared/schemas/policy';

export const GET = route({
  auth: 'tenant', capability: 'incidents.review', input: appealListQuery,
  handler: async ({ tenant, input }) => ({ data: await listTenantAppeals(tenant, input) }),
});
