import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { getOrder } from '@/server/domains/commerce/orders';

/** Line snapshots, totals, read-only payment/refund status, fulfillment history. Costs only with costs.view. */
export const GET = route({
  auth: 'tenant', capability: 'orders.view', feature: 'feature.products',
  handler: async ({ tenant, params }) => ({ data: await getOrder(tenant, requireUuidParam(params, 'id')) }),
});
