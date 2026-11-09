import { route } from '@/server/http/route';
import { loomPlannerApi, planRequestInput } from '@/loom';
import '@/server/loom-host/planner-port';
import { LOOM_FEATURE, LOOM_MANAGE, LOOM_VIEW, loomCtx } from '@/server/loom-host/access';

/** GET /loom/plans — latest planner runs (monthly, weekly, revisions) with source and the honest AI note. */
export const GET = route({
  auth: 'tenant', capability: LOOM_VIEW, feature: LOOM_FEATURE,
  handler: async ({ tenant, locale }) => ({ data: await loomPlannerApi.listPlannerRuns({ businessId: tenant.tenantId, locale }) }),
});

/** POST /loom/plans { kind, period_start?, mode? } → 202 { job_id } (one live run per kind; an existing one is returned with 200). */
export const POST = route({
  auth: 'tenant', capability: LOOM_MANAGE, feature: LOOM_FEATURE, input: planRequestInput,
  rateLimit: { scope: 'user', limit: 30, windowSec: 3600, name: 'loom-plans' },
  handler: async ({ tenant, actor, locale, input }) => {
    const r = await loomPlannerApi.startPlan(loomCtx(tenant, actor, locale), input);
    return { status: r.created ? 202 : 200, data: r };
  },
});
