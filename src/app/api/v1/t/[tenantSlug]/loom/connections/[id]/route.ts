import { route } from '@/server/http/route';
import { loomConnections } from '@/loom';
import { LOOM_CONNECTIONS, LOOM_FEATURE, loomCtx } from '@/server/loom-host/access';

/** GET /loom/connections/{id} — detail: mapping, files, suspected duplicates, sync runs, first-snapshot review. */
export const GET = route({
  auth: 'tenant', capability: LOOM_CONNECTIONS, feature: LOOM_FEATURE,
  handler: async ({ tenant, locale, params }) => ({ data: await loomConnections.get({ businessId: tenant.tenantId, locale }, params.id!) }),
});

/** PATCH — name, REST config, auth secret (write-only), ingest secret rotation (returned once). */
export const PATCH = route({
  auth: 'tenant', capability: LOOM_CONNECTIONS, feature: LOOM_FEATURE, input: loomConnections.updateConnectionInput,
  handler: async ({ tenant, actor, locale, params, input }) => ({ data: await loomConnections.update(loomCtx(tenant, actor, locale), params.id!, input) }),
});

/** POST { action: test | sync | pause | resume } — healthcheck, sync now (+ review), lifecycle. */
export const POST = route({
  auth: 'tenant', capability: LOOM_CONNECTIONS, feature: LOOM_FEATURE, input: loomConnections.connectionActionInput,
  rateLimit: { scope: 'user', limit: 60, windowSec: 3600, name: 'loom-connection-actions' },
  handler: async ({ tenant, actor, locale, params, input }) => ({ data: await loomConnections.action(loomCtx(tenant, actor, locale), params.id!, input.action) }),
});
