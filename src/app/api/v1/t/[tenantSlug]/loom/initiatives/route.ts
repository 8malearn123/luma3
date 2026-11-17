import { route } from '@/server/http/route';
import { initiativeListQuery, loomMemory } from '@/loom';
import { LOOM_FEATURE, LOOM_VIEW } from '@/server/loom-host/access';

/** GET /loom/initiatives?status= — initiative records (§10.2) with execution, measured results, quality and learnings. */
export const GET = route({
  auth: 'tenant', capability: LOOM_VIEW, feature: LOOM_FEATURE, input: initiativeListQuery,
  handler: async ({ tenant, locale, input }) => ({ data: await loomMemory.listInitiatives({ businessId: tenant.tenantId, locale }, input) }),
});
