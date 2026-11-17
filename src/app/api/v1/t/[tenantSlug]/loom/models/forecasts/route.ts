import { route } from '@/server/http/route';
import { loomModels } from '@/loom';
import { LOOM_FEATURE, LOOM_VIEW } from '@/server/loom-host/access';

/** GET /loom/models/forecasts — latest forecasts per kind, only from ACTIVE versions or labelled baselines, with interval and version. */
export const GET = route({
  auth: 'tenant', capability: LOOM_VIEW, feature: LOOM_FEATURE,
  handler: async ({ tenant, locale }) => ({ data: await loomModels.forecasts({ businessId: tenant.tenantId, locale }) }),
});
