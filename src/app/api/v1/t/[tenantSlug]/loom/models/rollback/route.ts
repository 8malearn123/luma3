import { route } from '@/server/http/route';
import { loomModels, rollbackInput } from '@/loom';
import { LOOM_FEATURE, LOOM_MANAGE, loomCtx } from '@/server/loom-host/access';

/** POST /loom/models/rollback { model_kind } — one click: retire the active version and restore the previous one (or the baseline). */
export const POST = route({
  auth: 'tenant', capability: LOOM_MANAGE, feature: LOOM_FEATURE, input: rollbackInput,
  handler: async ({ tenant, actor, locale, input }) => ({ data: await loomModels.rollbackKind(loomCtx(tenant, actor, locale), input.model_kind) }),
});
