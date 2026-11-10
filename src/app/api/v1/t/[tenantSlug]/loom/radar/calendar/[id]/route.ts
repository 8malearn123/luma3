import { route } from '@/server/http/route';
import { isUuid } from '@/server/db/client';
import { Errors } from '@/server/http/errors';
import { calendarActionInput, radarApi, recordTimingPlan, timingPlanCommand } from '@/loom';
import { LOOM_FEATURE, LOOM_MANAGE, loomCtx } from '@/server/loom-host/access';
import { lumaActionPort } from '@/server/loom-host/actions';

/** POST /loom/radar/calendar/{id} — adopt | hide | reset | attach(opportunity_id) | detach | add_to_plan. */
export const POST = route({
  auth: 'tenant', capability: LOOM_MANAGE, feature: LOOM_FEATURE, input: calendarActionInput, idempotency: 'optional',
  handler: async ({ tenant, actor, locale, params, input }) => {
    if (!isUuid(params.id)) throw Errors.notFound('calendar_event');
    const c = loomCtx(tenant, actor, locale);
    if (input.action === 'add_to_plan') {
      const ref = { kind: input.origin === 'owner' ? 'owner_event' as const : 'platform_event' as const, id: params.id };
      const { command } = await timingPlanCommand(tenant.tenantId, ref);
      const result = await lumaActionPort(tenant, actor, locale).execute(tenant.tenantId, command);
      await recordTimingPlan(c, ref, `${result.target}:${result.ref_id}:${result.status}`);
      return { status: 201, data: { result } };
    }
    return { data: await radarApi.calendarAction(c, params.id, input) };
  },
});
