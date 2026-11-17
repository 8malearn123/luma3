import { route } from '@/server/http/route';
import { loomMemory } from '@/loom';
import { LOOM_FEATURE, LOOM_VIEW } from '@/server/loom-host/access';

/** GET /loom/results — home summary: counts per initiative status, latest measured results, material change alerts. */
export const GET = route({
  auth: 'tenant', capability: LOOM_VIEW, feature: LOOM_FEATURE,
  handler: async ({ tenant, locale }) => ({ data: await loomMemory.resultsSummary({ businessId: tenant.tenantId, locale }) }),
});
