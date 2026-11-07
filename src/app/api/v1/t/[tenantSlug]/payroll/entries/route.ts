import { z } from 'zod';
import { route } from '@/server/http/route';
import { addPayrollEntry, listPayrollEntries, MONTH_RE, payrollEntryInput } from '@/server/domains/payroll/service';

/** GET bonuses, deductions, advances and tips dated in a month. */
export const GET = route({
  auth: 'tenant', capability: 'payroll.view', input: z.object({ month: z.string().regex(MONTH_RE) }),
  handler: async ({ tenant, input }) => ({ data: await listPayrollEntries(tenant, input.month) }),
});

/** POST record a bonus, deduction, advance or tip. */
export const POST = route({
  auth: 'tenant', capability: 'payroll.manage', input: payrollEntryInput,
  handler: async ({ tenant, actor, input }) => ({ status: 201, data: await addPayrollEntry(tenant, actor, input) }),
});
