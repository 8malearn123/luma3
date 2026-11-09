import { route } from '@/server/http/route';
import { loomConnections } from '@/loom';
import { LOOM_CONNECTIONS, LOOM_FEATURE, loomCtx } from '@/server/loom-host/access';

/** GET /loom/connections — every connection: status, review gate, last sync, errors, record counts, health (no secrets). */
export const GET = route({
  auth: 'tenant', capability: LOOM_CONNECTIONS, feature: LOOM_FEATURE,
  handler: async ({ tenant }) => ({ data: await loomConnections.list({ businessId: tenant.tenantId }) }),
});

/** POST /loom/connections — a CSV import or REST connection (starts at `pending_mapping`; the ingest secret is returned once). */
export const POST = route({
  auth: 'tenant', capability: LOOM_CONNECTIONS, feature: LOOM_FEATURE, input: loomConnections.createConnectionInput,
  rateLimit: { scope: 'user', limit: 20, windowSec: 3600, name: 'loom-connections' },
  handler: async ({ tenant, actor, locale, input }) => ({ status: 201, data: await loomConnections.create(loomCtx(tenant, actor, locale), input) }),
});
