import { route } from '@/server/http/route';
import { loomMemory } from '@/loom';
import { LOOM_FEATURE, LOOM_VIEW } from '@/server/loom-host/access';

/** GET /loom/changes — change-aggregator signals (§13) with what they re-checked and the plan revisions they proposed. */
export const GET = route({
  auth: 'tenant', capability: LOOM_VIEW, feature: LOOM_FEATURE,
  handler: async ({ tenant, locale }) => ({ data: await loomMemory.listChanges({ businessId: tenant.tenantId, locale }) }),
});
