import { route } from '@/server/http/route';
import { loomApi } from '@/loom';
import { LOOM_FEATURE, LOOM_VIEW } from '@/server/loom-host/access';

/** GET /loom/data-quality — the latest data-quality report (§5.4) with what improves each domain. */
export const GET = route({
  auth: 'tenant', capability: LOOM_VIEW, feature: LOOM_FEATURE,
  handler: async ({ tenant, locale }) => ({ data: await loomApi.getDataQuality({ businessId: tenant.tenantId, locale }) }),
});
