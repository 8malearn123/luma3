import { route } from '@/server/http/route';
import { addPayrollEntry, tipInput } from '@/server/domains/payroll/service';

/** POST record a tip for a staff member who served a booking (cashier or payroll). */
export const POST = route({
  auth: 'tenant', capability: ['payments.collect', 'payroll.manage'], input: tipInput,
  handler: async ({ tenant, actor, input }) => ({ status: 201, data: await addPayrollEntry(tenant, actor, { ...input, kind: 'tip' }) }),
});
