import { platformRoute } from '@/server/domains/platform/guard';
import { listTenants } from '@/server/domains/platform/tenants';
import { tenantListQuery } from '@/shared/schemas/platform';

/** GET /api/v1/platform/tenants — businesses (allowlisted fields), search/filter/sort/paginate. */
export const GET = platformRoute({
  platformCapability: 'platform.tenants.view', input: tenantListQuery,
  handler: async ({ input }) => ({ data: await listTenants(input) }),
});
