import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { postReceipt } from '@/server/domains/commerce/purchasing';

/** Adds the received stock (exactly once). */
export const POST = route({
  auth: 'tenant', capability: 'purchasing.receive', feature: 'feature.purchasing', idempotency: 'optional',
  handler: async ({ tenant, actor, params }) => ({ data: await postReceipt(tenant, actor, requireUuidParam(params, 'id')) }),
});
