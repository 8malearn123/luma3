import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { orderSellerInput, setOrderSeller } from '@/server/domains/payroll/service';

/** PUT who sold this order (product commission goes to her when the business has it switched on). */
export const PUT = route({
  auth: 'tenant', capability: ['orders.manage', 'payroll.manage'], input: orderSellerInput,
  handler: async ({ tenant, actor, params, input }) => ({ data: await setOrderSeller(tenant, actor, requireUuidParam(params, 'id'), input) }),
});
