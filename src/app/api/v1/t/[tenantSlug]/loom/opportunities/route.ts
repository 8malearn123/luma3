import { route } from '@/server/http/route';
import { loomApi, opportunityListQuery } from '@/loom';
import { LOOM_FEATURE, LOOM_VIEW } from '@/server/loom-host/access';

/** GET /loom/opportunities?status=&category=&bucket= — full §11.1 cards, ranked. */
export const GET = route({
  auth: 'tenant', capability: LOOM_VIEW, feature: LOOM_FEATURE, input: opportunityListQuery,
  handler: async ({ tenant, locale, input }) => ({ data: await loomApi.listOpportunities({ businessId: tenant.tenantId, locale }, input) }),
});
