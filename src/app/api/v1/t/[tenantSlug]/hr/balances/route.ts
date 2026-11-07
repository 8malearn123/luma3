import { z } from 'zod';
import { route } from '@/server/http/route';
import { listBalances } from '@/server/domains/hr/balance';

/** GET annual leave balances: everyone for approvers, otherwise the caller's own. */
export const GET = route({
  auth: 'tenant', capability: ['hr.request', 'leave.request', 'leave.approve', 'schedule.manage', 'hr.configure'],
  input: z.object({ staff_id: z.string().uuid().optional() }),
  handler: async ({ tenant, input }) => ({ data: await listBalances(tenant, input.staff_id) }),
});
