import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { paySlip, paySlipInput } from '@/server/domains/payroll/service';

/** POST record that a closed payslip was paid out (once). */
export const POST = route({
  auth: 'tenant', capability: 'payroll.manage', input: paySlipInput,
  handler: async ({ tenant, actor, params, input }) => ({ data: await paySlip(tenant, actor, requireUuidParam(params, 'id'), input) }),
});
