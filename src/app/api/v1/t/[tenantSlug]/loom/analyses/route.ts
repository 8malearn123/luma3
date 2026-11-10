import { route } from '@/server/http/route';
import { loomApi } from '@/loom';
import { LOOM_FEATURE, LOOM_MANAGE, LOOM_VIEW, loomCtx } from '@/server/loom-host/access';

export const GET = route({
  auth: 'tenant', capability: LOOM_VIEW, feature: LOOM_FEATURE,
  handler: async ({ tenant, locale }) => ({ data: await loomApi.listAnalyses({ businessId: tenant.tenantId, locale }) }),
});

/** POST /loom/analyses → 202 { job_id } (one live analysis per business; an existing one is returned with 200). */
export const POST = route({
  auth: 'tenant', capability: LOOM_MANAGE, feature: LOOM_FEATURE,
  rateLimit: { scope: 'user', limit: 30, windowSec: 3600, name: 'loom-analyses' },
  handler: async ({ tenant, actor, locale }) => {
    const r = await loomApi.startAnalysis(loomCtx(tenant, actor, locale));
    return { status: r.created ? 202 : 200, data: r };
  },
});
