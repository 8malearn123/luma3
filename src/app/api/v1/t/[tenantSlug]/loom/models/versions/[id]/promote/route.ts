import { route } from '@/server/http/route';
import { isUuid } from '@/server/db/client';
import { Errors } from '@/server/http/errors';
import { loomModels } from '@/loom';
import { LOOM_FEATURE, LOOM_MANAGE, loomCtx } from '@/server/loom-host/access';

/** POST /loom/models/versions/{id}/promote — candidate → shadow (gate passed) or shadow → active (shadow evaluation passed). Never bypasses a gate. */
export const POST = route({
  auth: 'tenant', capability: LOOM_MANAGE, feature: LOOM_FEATURE,
  handler: async ({ tenant, actor, locale, params }) => {
    if (!isUuid(params.id)) throw Errors.notFound('model version');
    return { data: await loomModels.promote(loomCtx(tenant, actor, locale), params.id) };
  },
});
