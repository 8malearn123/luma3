import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { setCommissionOverride, staffCommissionInput } from '@/server/domains/payroll/service';

/** PUT a staff member's override for services and/or products (null removes it). */
export const PUT = route({
  auth: 'tenant', capability: 'payroll.manage', input: staffCommissionInput,
  handler: async ({ tenant, actor, params, input }) => ({ data: await setCommissionOverride(tenant, actor, requireUuidParam(params, 'staffId'), input) }),
});
