import { platformRoute } from '@/server/domains/platform/guard';
import { loomBusinesses } from '@/loom';
import { opBody, runConnectionOp } from '@/server/loom-host/connection-ops';

/** POST …/connections/{id}/{mapping|files|review|links} — same operations as the tenant routes; review = platform confirmation. */
export const POST = platformRoute({
  platformCapability: 'platform.loom.manage', input: opBody,
  handler: async ({ params, actor, locale, input }) => runConnectionOp(params.op!, { businessId: await loomBusinesses.resolveExternal(params.businessId!), actor, locale }, params.id!, input),
});
export const PUT = POST;
