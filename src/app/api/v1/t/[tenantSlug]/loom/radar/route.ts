import { route } from '@/server/http/route';
import { radarApi } from '@/loom';
import { LOOM_FEATURE, LOOM_VIEW } from '@/server/loom-host/access';
import '@/server/loom-host/radar';

/** GET /loom/radar — sources with connection status, live clusters (evidence class, freshness, relevance, linked opportunity), stale and dismissed ones. */
export const GET = route({
  auth: 'tenant', capability: LOOM_VIEW, feature: LOOM_FEATURE,
  handler: async ({ tenant, locale }) => ({ data: await radarApi.getRadar({ businessId: tenant.tenantId, locale }) }),
});
