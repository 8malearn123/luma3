import { z } from 'zod';
import { route } from '@/server/http/route';
import { isUuid } from '@/server/db/client';
import { Errors } from '@/server/http/errors';
import { loomPlannerApi } from '@/loom';
import '@/server/loom-host/planner-port';
import { LOOM_FEATURE, LOOM_VIEW } from '@/server/loom-host/access';

/** GET /loom/plans/{id}/actions[?version_id=] — structured plan actions (checks, materials, real slots, knowledge) of a version. */
export const GET = route({
  auth: 'tenant', capability: LOOM_VIEW, feature: LOOM_FEATURE, input: z.object({ version_id: z.string().uuid().optional() }).strict(),
  handler: async ({ tenant, locale, params, input }) => {
    if (!isUuid(params.id)) throw Errors.notFound('plan');
    return { data: await loomPlannerApi.getPlanActions({ businessId: tenant.tenantId, locale }, params.id, input.version_id ?? null) };
  },
});
