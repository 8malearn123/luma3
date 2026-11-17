import { route } from '@/server/http/route';
import { isUuid } from '@/server/db/client';
import { Errors } from '@/server/http/errors';
import { loomApi } from '@/loom';
import { LOOM_FEATURE, LOOM_VIEW } from '@/server/loom-host/access';

/** GET /loom/opportunities/{id} — card, evidence rows, latest checks and the event history, decision ladder and the caller's reaction. */
export const GET = route({
  auth: 'tenant', capability: LOOM_VIEW, feature: LOOM_FEATURE,
  handler: async ({ tenant, actor, locale, params }) => {
    if (!isUuid(params.id)) throw Errors.notFound('opportunity');
    return { data: await loomApi.getOpportunity({ businessId: tenant.tenantId, locale, actor }, params.id) };
  },
});
