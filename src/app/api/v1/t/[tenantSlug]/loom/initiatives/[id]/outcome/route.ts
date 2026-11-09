import { route } from '@/server/http/route';
import { isUuid } from '@/server/db/client';
import { Errors } from '@/server/http/errors';
import { loomMemory } from '@/loom';
import { LOOM_FEATURE, LOOM_VIEW } from '@/server/loom-host/access';

/** GET /loom/initiatives/{id}/outcome — measured result with measurement quality, attributed vs incremental, guardrails and limitations. */
export const GET = route({
  auth: 'tenant', capability: LOOM_VIEW, feature: LOOM_FEATURE,
  handler: async ({ tenant, locale, params }) => {
    if (!isUuid(params.id)) throw Errors.notFound('initiative');
    return { data: await loomMemory.getOutcome({ businessId: tenant.tenantId, locale }, params.id) };
  },
});
