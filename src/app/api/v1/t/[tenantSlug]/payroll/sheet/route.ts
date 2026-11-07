import { z } from 'zod';
import { route } from '@/server/http/route';
import { MONTH_RE, payrollSheet } from '@/server/domains/payroll/service';

/** GET the payroll sheet for a month: a live draft, or the frozen payslips once closed. */
export const GET = route({
  auth: 'tenant', capability: 'payroll.view', input: z.object({ month: z.string().regex(MONTH_RE) }),
  handler: async ({ tenant, input }) => ({ data: await payrollSheet(tenant, input.month) }),
});
