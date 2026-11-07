import { z } from 'zod';
import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { voidPayrollEntry } from '@/server/domains/payroll/service';

/** POST void an unsettled payroll entry with a reason (never deleted). */
export const POST = route({
  auth: 'tenant', capability: 'payroll.manage', input: z.object({ reason: z.string().trim().min(3).max(300) }).strict(),
  handler: async ({ tenant, actor, params, input }) => ({ data: await voidPayrollEntry(tenant, actor, requireUuidParam(params, 'id'), input.reason) }),
});
