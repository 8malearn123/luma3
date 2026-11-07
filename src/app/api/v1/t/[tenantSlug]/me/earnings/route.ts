import { z } from 'zod';
import { route } from '@/server/http/route';
import { MONTH_RE, myEarnings } from '@/server/domains/payroll/service';

/** GET my earnings for a month (live draft or my frozen payslip) and my recent payslips. */
export const GET = route({
  auth: 'tenant', capability: 'payroll.view_own', input: z.object({ month: z.string().regex(MONTH_RE) }),
  handler: async ({ tenant, input }) => ({ data: await myEarnings(tenant, input.month) }),
});
