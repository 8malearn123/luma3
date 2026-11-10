import { route } from '@/server/http/route';
import { loomApi } from '@/loom';
import { LOOM_FEATURE, LOOM_VIEW } from '@/server/loom-host/access';

/** GET /loom/analyses/{id} — job status and result summary. */
export const GET = route({
  auth: 'tenant', capability: LOOM_VIEW, feature: LOOM_FEATURE,
  handler: async ({ tenant, locale, params }) => ({ data: await loomApi.getAnalysis({ businessId: tenant.tenantId, locale }, params.id!) }),
});
