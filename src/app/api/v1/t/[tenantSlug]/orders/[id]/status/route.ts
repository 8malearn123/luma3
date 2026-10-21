import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { setFulfillmentStatus } from '@/server/domains/commerce/orders';
import { orderStatusInput } from '@/shared/schemas/commerce';

/** paid → preparing → ready → collected (forward only). Collecting never touches stock. */
export const POST = route({
  auth: 'tenant', capability: 'orders.manage', feature: 'feature.products', input: orderStatusInput,
  handler: async ({ tenant, actor, input, params }) => ({ data: await setFulfillmentStatus(tenant, actor, requireUuidParam(params, 'id'), input.to) }),
});
