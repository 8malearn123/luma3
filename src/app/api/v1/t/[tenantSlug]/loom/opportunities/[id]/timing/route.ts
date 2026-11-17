import { route } from '@/server/http/route';
import { isUuid } from '@/server/db/client';
import { Errors } from '@/server/http/errors';
import { timingContextFor } from '@/loom';
import { LOOM_FEATURE, LOOM_VIEW } from '@/server/loom-host/access';

/** GET /loom/opportunities/{id}/timing — the TimingContext the planner uses (events, attached signals, fixed rules). */
export const GET = route({
  auth: 'tenant', capability: LOOM_VIEW, feature: LOOM_FEATURE,
  handler: async ({ tenant, params }) => {
    if (!isUuid(params.id)) throw Errors.notFound('opportunity');
    return { data: await timingContextFor(tenant.tenantId, params.id) };
  },
});
