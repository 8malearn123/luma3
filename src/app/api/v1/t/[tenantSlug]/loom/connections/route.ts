import { route } from '@/server/http/route';
import { loomApi } from '@/loom';
import { LOOM_CONNECTIONS, LOOM_FEATURE } from '@/server/loom-host/access';

/** GET /loom/connections — connector status, last sync, health and manifest (loom.connections.manage → business.manage). */
export const GET = route({
  auth: 'tenant', capability: LOOM_CONNECTIONS, feature: LOOM_FEATURE,
  handler: async ({ tenant }) => ({ data: await loomApi.listConnections({ businessId: tenant.tenantId }) }),
});
