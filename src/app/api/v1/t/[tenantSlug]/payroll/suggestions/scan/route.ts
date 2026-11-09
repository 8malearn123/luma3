import { z } from 'zod';
import { route } from '@/server/http/route';
import { scanMonth } from '@/server/domains/hr/deductions';
import { MONTH_RE } from '@/server/domains/payroll/service';

/** POST compare attendance with the schedule for a month (up to today) and add new suggestions. */
export const POST = route({
  auth: 'tenant', capability: 'payroll.manage', input: z.object({ month: z.string().regex(MONTH_RE) }).strict(),
  handler: async ({ tenant, input }) => ({ data: await scanMonth(tenant, input.month) }),
});
