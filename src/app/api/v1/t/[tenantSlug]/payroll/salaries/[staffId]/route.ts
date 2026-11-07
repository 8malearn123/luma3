import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { baseSalaryInput, setBaseSalary } from '@/server/domains/payroll/service';

/** PUT a staff member's monthly base salary (0 = commission and tips only). */
export const PUT = route({
  auth: 'tenant', capability: 'payroll.manage', input: baseSalaryInput,
  handler: async ({ tenant, actor, params, input }) => ({ data: await setBaseSalary(tenant, actor, requireUuidParam(params, 'staffId'), input) }),
});
