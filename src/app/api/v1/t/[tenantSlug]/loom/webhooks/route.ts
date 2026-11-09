import { route } from '@/server/http/route';
import { loomWebhooks } from '@/loom';
import { LOOM_CONNECTIONS, LOOM_FEATURE, loomCtx } from '@/server/loom-host/access';

/** GET /loom/webhooks — outgoing endpoints (no secrets) and the recent delivery log. */
export const GET = route({
  auth: 'tenant', capability: LOOM_CONNECTIONS, feature: LOOM_FEATURE,
  handler: async ({ tenant }) => ({ data: await loomWebhooks.listEndpoints({ businessId: tenant.tenantId }) }),
});

/** POST /loom/webhooks — subscribe an https endpoint to plan.ready / opportunity.created / plan.revision_proposed / outcome.measured. The signing secret is returned once. */
export const POST = route({
  auth: 'tenant', capability: LOOM_CONNECTIONS, feature: LOOM_FEATURE, input: loomWebhooks.endpointInput,
  handler: async ({ tenant, actor, locale, input }) => ({ status: 201, data: await loomWebhooks.createEndpoint(loomCtx(tenant, actor, locale), input) }),
});
