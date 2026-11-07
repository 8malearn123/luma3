import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { serviceCommissionInput, setServiceCommission } from '@/server/domains/payroll/service';

/** PUT one service's commission switch and percentage. */
export const PUT = route({
  auth: 'tenant', capability: 'payroll.manage', input: serviceCommissionInput,
  handler: async ({ tenant, actor, params, input }) => ({ data: await setServiceCommission(tenant, actor, requireUuidParam(params, 'serviceId'), input) }),
});
