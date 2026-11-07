import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { adjustBalance, balanceAdjustInput, balanceHistory } from '@/server/domains/hr/balance';

/** GET the leave ledger (days taken and adjustments) of a staff member. */
export const GET = route({
  auth: 'tenant', capability: ['hr.request', 'leave.request', 'leave.approve', 'schedule.manage', 'hr.configure'],
  handler: async ({ tenant, params }) => ({ data: await balanceHistory(tenant, requireUuidParam(params, 'staffId')) }),
});
/** POST an adjustment (± days, with a note) to the annual balance. */
export const POST = route({
  auth: 'tenant', capability: 'hr.configure', input: balanceAdjustInput,
  handler: async ({ tenant, actor, params, input }) => ({ status: 201, data: await adjustBalance(tenant, actor, requireUuidParam(params, 'staffId'), input) }),
});
