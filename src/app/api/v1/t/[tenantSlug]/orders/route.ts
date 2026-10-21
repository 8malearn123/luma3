import { route } from '@/server/http/route';
import { listOrders } from '@/server/domains/commerce/orders';
import { orderListQuery } from '@/shared/schemas/commerce';

export const GET = route({
  auth: 'tenant', capability: 'orders.view', feature: 'feature.products', input: orderListQuery,
  handler: async ({ tenant, input }) => ({ data: await listOrders(tenant, input) }),
});
