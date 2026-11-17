import { route } from '@/server/http/route';
import { isUuid } from '@/server/db/client';
import { Errors } from '@/server/http/errors';
import { executionInput, loomMemory } from '@/loom';
import { LOOM_FEATURE, LOOM_MANAGE, loomCtx } from '@/server/loom-host/access';

/** POST /loom/initiatives/{id}/executions — records what was actually executed (dates, audience, channel, actual cost). */
export const POST = route({
  auth: 'tenant', capability: LOOM_MANAGE, feature: LOOM_FEATURE, input: executionInput, idempotency: 'optional',
  handler: async ({ tenant, actor, locale, params, input }) => {
    if (!isUuid(params.id)) throw Errors.notFound('initiative');
    return { status: 201, data: await loomMemory.addExecution(loomCtx(tenant, actor, locale), params.id, input) };
  },
});
