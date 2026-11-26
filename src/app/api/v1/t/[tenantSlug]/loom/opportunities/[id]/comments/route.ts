import { route } from '@/server/http/route';
import { isUuid } from '@/server/db/client';
import { Errors } from '@/server/http/errors';
import { commentInput, loomPlannerApi } from '@/loom';
import { LOOM_FEATURE, LOOM_MANAGE, LOOM_VIEW, loomCtx } from '@/server/loom-host/access';

/** GET /loom/opportunities/{id}/comments — notes on an opportunity (append-only). */
export const GET = route({
  auth: 'tenant', capability: LOOM_VIEW, feature: LOOM_FEATURE,
  handler: async ({ tenant, locale, params }) => {
    if (!isUuid(params.id)) throw Errors.notFound('opportunity');
    return { data: await loomPlannerApi.listComments({ businessId: tenant.tenantId, locale }, params.id) };
  },
});

/** POST /loom/opportunities/{id}/comments { body } */
export const POST = route({
  auth: 'tenant', capability: LOOM_MANAGE, feature: LOOM_FEATURE, input: commentInput,
  handler: async ({ tenant, actor, locale, params, input }) => {
    if (!isUuid(params.id)) throw Errors.notFound('opportunity');
    return { status: 201, data: await loomPlannerApi.addComment(loomCtx(tenant, actor, locale), params.id, input.body) };
  },
});
