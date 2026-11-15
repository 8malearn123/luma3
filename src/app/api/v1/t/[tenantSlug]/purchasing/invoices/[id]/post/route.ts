import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { postInvoice } from '@/server/domains/commerce/purchasing';

/** Posts the invoice to accounts payable (once). */
export const POST = route({
  auth: 'tenant', capability: 'purchasing.manage', feature: 'feature.purchasing', idempotency: 'optional',
  handler: async ({ tenant, actor, params }) => ({ data: await postInvoice(tenant, actor, requireUuidParam(params, 'id')) }),
});
