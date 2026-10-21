import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { cancelOrderByStaff } from '@/server/domains/commerce/orders';
import { orderCancelInput } from '@/shared/schemas/commerce';

/** Releases stock exactly once; refuses collected orders. Refunds are requested through payments. */
export const POST = route({
  auth: 'tenant', capability: 'orders.manage', feature: 'feature.products', input: orderCancelInput,
  handler: async ({ tenant, actor, input, params }) => ({ data: await cancelOrderByStaff(tenant, actor, requireUuidParam(params, 'id'), input.reason) }),
});
