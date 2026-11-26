import { route } from '@/server/http/route';
import { loomConnections } from '@/loom';
import { LOOM_CONNECTIONS, LOOM_FEATURE } from '@/server/loom-host/access';

/** GET /loom/connections/templates — the documented import templates per canonical entity (fields, types, example CSV). */
export const GET = route({
  auth: 'tenant', capability: LOOM_CONNECTIONS, feature: LOOM_FEATURE,
  handler: async ({ locale }) => ({ data: loomConnections.templates(locale) }),
});
