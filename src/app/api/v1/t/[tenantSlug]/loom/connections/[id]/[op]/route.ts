import { route } from '@/server/http/route';
import { LOOM_CONNECTIONS, LOOM_FEATURE, loomCtx } from '@/server/loom-host/access';
import { opBody, runConnectionOp } from '@/server/loom-host/connection-ops';

/**
 * POST /loom/connections/{id}/{op}:
 *   mapping  the mapping step (columns, status map, revenue basis, timezone, currency)
 *   files    CSV upload (validated against the template)
 *   review   first-snapshot confirmation { decision: approve | reject, primary? }
 *   links    mark a suspected duplicate { link_id, status: confirmed | rejected } (never merged automatically)
 */
export const POST = route({
  auth: 'tenant', capability: LOOM_CONNECTIONS, feature: LOOM_FEATURE, input: opBody,
  rateLimit: { scope: 'user', limit: 120, windowSec: 3600, name: 'loom-connection-ops' },
  handler: async ({ tenant, actor, locale, params, input }) => runConnectionOp(params.op!, loomCtx(tenant, actor, locale), params.id!, input),
});
export const PUT = POST;
