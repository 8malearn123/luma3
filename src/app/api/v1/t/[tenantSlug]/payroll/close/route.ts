import { z } from 'zod';
import { route } from '@/server/http/route';
import { closeMonth, MONTH_RE } from '@/server/domains/payroll/service';

/** POST close a month: freezes one payslip per staff member and posts the payroll journal. Months close once and in order. */
export const POST = route({
  auth: 'tenant', capability: 'payroll.manage', input: z.object({ month: z.string().regex(MONTH_RE) }).strict(),
  handler: async ({ tenant, actor, input }) => ({ status: 201, data: await closeMonth(tenant, actor, input.month) }),
});
