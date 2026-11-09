import { route } from '@/server/http/route';
import { isUuid } from '@/server/db/client';
import { Errors } from '@/server/http/errors';
import { marketObservationPatch, radarApi } from '@/loom';
import { LOOM_FEATURE, LOOM_MANAGE, loomCtx } from '@/server/loom-host/access';

/** PATCH /loom/market-observations/{id} — note, comparability (+ reasons), archive. */
export const PATCH = route({
  auth: 'tenant', capability: LOOM_MANAGE, feature: LOOM_FEATURE, input: marketObservationPatch,
  handler: async ({ tenant, actor, locale, params, input }) => {
    if (!isUuid(params.id)) throw Errors.notFound('market_observation');
    return { data: await radarApi.patchMarketObservation(loomCtx(tenant, actor, locale), params.id, input) };
  },
});
