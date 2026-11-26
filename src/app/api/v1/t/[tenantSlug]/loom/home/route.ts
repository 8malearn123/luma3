import { route } from '@/server/http/route';
import { loomPlannerApi } from '@/loom';
import '@/server/loom-host/planner-port';
import { localToday } from '@/server/domains/analytics/period';
import { LOOM_FEATURE, LOOM_VIEW } from '@/server/loom-host/access';

/** GET /loom/home — §11.3 home page: situation + data quality, top opportunities, plan & this week, pending decisions, alerts, setup. */
export const GET = route({
  auth: 'tenant', capability: LOOM_VIEW, feature: LOOM_FEATURE,
  handler: async ({ tenant, locale }) => ({ data: await loomPlannerApi.home({ businessId: tenant.tenantId, locale }, localToday(tenant.timezone)) }),
});
