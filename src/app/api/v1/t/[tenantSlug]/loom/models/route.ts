import { route } from '@/server/http/route';
import { loomModels } from '@/loom';
import { LOOM_FEATURE, LOOM_VIEW } from '@/server/loom-host/access';

/** GET /loom/models — learned models (experimental): eligibility and why, active / shadow / candidates with metrics vs baseline, consent. */
export const GET = route({
  auth: 'tenant', capability: LOOM_VIEW, feature: LOOM_FEATURE,
  handler: async ({ tenant, locale }) => ({ data: await loomModels.overview({ businessId: tenant.tenantId, locale }) }),
});
