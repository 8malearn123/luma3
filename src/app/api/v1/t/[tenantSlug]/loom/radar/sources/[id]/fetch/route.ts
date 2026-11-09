import { route } from '@/server/http/route';
import { isUuid } from '@/server/db/client';
import { Errors } from '@/server/http/errors';
import { radarApi } from '@/loom';
import { LOOM_FEATURE, LOOM_MANAGE, loomCtx } from '@/server/loom-host/access';
import '@/server/loom-host/radar';

/** POST /loom/radar/sources/{id}/fetch — fetch now (deduplicated) and re-cluster. */
export const POST = route({
  auth: 'tenant', capability: LOOM_MANAGE, feature: LOOM_FEATURE,
  handler: async ({ tenant, actor, locale, params }) => {
    if (!isUuid(params.id)) throw Errors.notFound('source');
    return { data: { fetch: await radarApi.fetchSourceNow(loomCtx(tenant, actor, locale), params.id) } };
  },
});
