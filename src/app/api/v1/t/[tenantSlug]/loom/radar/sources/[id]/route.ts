import { route } from '@/server/http/route';
import { isUuid } from '@/server/db/client';
import { Errors } from '@/server/http/errors';
import { radarApi, signalSourcePatch } from '@/loom';
import { LOOM_FEATURE, LOOM_MANAGE, loomCtx } from '@/server/loom-host/access';

/** PATCH /loom/radar/sources/{id} — enable or disable a source. */
export const PATCH = route({
  auth: 'tenant', capability: LOOM_MANAGE, feature: LOOM_FEATURE, input: signalSourcePatch,
  handler: async ({ tenant, actor, locale, params, input }) => {
    if (!isUuid(params.id)) throw Errors.notFound('source');
    return { data: await radarApi.patchSource(loomCtx(tenant, actor, locale), params.id, input) };
  },
});
