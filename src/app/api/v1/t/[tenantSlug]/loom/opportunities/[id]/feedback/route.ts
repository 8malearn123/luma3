import { route } from '@/server/http/route';
import { isUuid } from '@/server/db/client';
import { Errors } from '@/server/http/errors';
import { feedbackInput, loomMemory } from '@/loom';
import { LOOM_FEATURE, LOOM_VIEW, loomCtx } from '@/server/loom-host/access';

/**
 * POST /loom/opportunities/{id}/feedback — { kind: 'viewed' } | { kind: 'reaction', reaction: like | dislike | none }.
 * Ladder stages `viewed` (usage) and `reacted` (taste). Neither is ever used as an outcome.
 */
export const POST = route({
  auth: 'tenant', capability: LOOM_VIEW, feature: LOOM_FEATURE, input: feedbackInput,
  handler: async ({ tenant, actor, locale, params, input }) => {
    if (!isUuid(params.id)) throw Errors.notFound('opportunity');
    return { data: await loomMemory.recordFeedback(loomCtx(tenant, actor, locale), params.id, input) };
  },
});
