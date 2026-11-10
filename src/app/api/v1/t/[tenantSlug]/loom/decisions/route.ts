import { route } from '@/server/http/route';
import { decisionsQuery, loomMemory } from '@/loom';
import { LOOM_FEATURE, LOOM_VIEW } from '@/server/loom-host/access';

/** GET /loom/decisions?opportunity_id=&initiative_id= — the decision ladder (§10.1, append-only). */
export const GET = route({
  auth: 'tenant', capability: LOOM_VIEW, feature: LOOM_FEATURE, input: decisionsQuery,
  handler: async ({ tenant, locale, input }) => ({ data: await loomMemory.listDecisions({ businessId: tenant.tenantId, locale }, input) }),
});
