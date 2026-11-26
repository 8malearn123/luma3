import { route } from '@/server/http/route';
import { isUuid } from '@/server/db/client';
import { Errors } from '@/server/http/errors';
import { clusterDecisionInput, radarApi, recordTimingPlan, timingPlanCommand } from '@/loom';
import { LOOM_FEATURE, LOOM_MANAGE, loomCtx } from '@/server/loom-host/access';
import { lumaActionPort } from '@/server/loom-host/actions';

/**
 * POST /loom/radar/clusters/{id} — dismiss | reopen | attach(opportunity_id) | detach | add_to_plan.
 * attach only to an EXISTING open internal opportunity (P1); add_to_plan needs an attachment and runs
 * through LUMA's ActionPort (a new plan version, never a campaign).
 */
export const POST = route({
  auth: 'tenant', capability: LOOM_MANAGE, feature: LOOM_FEATURE, input: clusterDecisionInput, idempotency: 'optional',
  handler: async ({ tenant, actor, locale, params, input }) => {
    if (!isUuid(params.id)) throw Errors.notFound('cluster');
    const c = loomCtx(tenant, actor, locale);
    if (input.action === 'add_to_plan') {
      const ref = { kind: 'signal_cluster' as const, id: params.id };
      const { command } = await timingPlanCommand(tenant.tenantId, ref);
      const result = await lumaActionPort(tenant, actor, locale).execute(tenant.tenantId, command);
      await recordTimingPlan(c, ref, `${result.target}:${result.ref_id}:${result.status}`);
      return { status: 201, data: { result } };
    }
    return { data: await radarApi.decideSignal(c, params.id, input) };
  },
});
