import { route } from '@/server/http/route';
import { isUuid } from '@/server/db/client';
import { Errors } from '@/server/http/errors';
import { decisionInput, loomApi } from '@/loom';
import { LOOM_FEATURE, LOOM_MANAGE, loomCtx } from '@/server/loom-host/access';

/** POST /loom/opportunities/{id}/decision — approve | study | defer (reason + until) | dismiss (categorised reason) | reopen. */
export const POST = route({
  auth: 'tenant', capability: LOOM_MANAGE, feature: LOOM_FEATURE, input: decisionInput,
  handler: async ({ tenant, actor, locale, params, input }) => {
    if (!isUuid(params.id)) throw Errors.notFound('opportunity');
    return { data: await loomApi.decideOpportunity(loomCtx(tenant, actor, locale), params.id, input) };
  },
});
