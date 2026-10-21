import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { createReturn } from '@/server/domains/commerce/orders';
import { returnInput } from '@/shared/schemas/commerce';

export const POST = route({
  auth: 'tenant', capability: 'orders.manage', feature: 'feature.products', input: returnInput,
  handler: async ({ tenant, actor, input, params }) => ({ status: 201, data: await createReturn(tenant, actor, requireUuidParam(params, 'id'), input) }),
});
