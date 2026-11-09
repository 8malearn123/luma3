import { route } from '@/server/http/route';
import { isUuid } from '@/server/db/client';
import { Errors } from '@/server/http/errors';
import { loomMemory } from '@/loom';
import { LOOM_FEATURE, LOOM_VIEW } from '@/server/loom-host/access';

/** GET /loom/initiatives/{id} — the full record: frozen baseline and original proposal, edits, executions, results and the ladder. */
export const GET = route({
  auth: 'tenant', capability: LOOM_VIEW, feature: LOOM_FEATURE,
  handler: async ({ tenant, locale, params }) => {
    if (!isUuid(params.id)) throw Errors.notFound('initiative');
    return { data: await loomMemory.getInitiative({ businessId: tenant.tenantId, locale }, params.id) };
  },
});
