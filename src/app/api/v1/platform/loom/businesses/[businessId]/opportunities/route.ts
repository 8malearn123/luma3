import { platformRoute } from '@/server/domains/platform/guard';
import { loomApi, loomBusinesses, opportunityListQuery } from '@/loom';

/** GET — opportunities of an external business (read-only here; decisions belong to its own system). */
export const GET = platformRoute({
  platformCapability: 'platform.loom.manage', input: opportunityListQuery,
  handler: async ({ params, locale, input }) => ({ data: await loomApi.listOpportunities({ businessId: await loomBusinesses.resolveExternal(params.businessId!), locale }, input) }),
});
