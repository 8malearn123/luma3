import { route } from '@/server/http/route';
import { loomWebhooks } from '@/loom';
import { LOOM_CONNECTIONS, LOOM_FEATURE, loomCtx } from '@/server/loom-host/access';

/** DELETE /loom/webhooks/{id} — deactivates the endpoint (the delivery log is kept). */
export const DELETE = route({
  auth: 'tenant', capability: LOOM_CONNECTIONS, feature: LOOM_FEATURE,
  handler: async ({ tenant, actor, locale, params }) => ({ data: await loomWebhooks.deactivateEndpoint(loomCtx(tenant, actor, locale), params.id!) }),
});
