import { route } from '@/server/http/route';
import { listCommissionOverrides } from '@/server/domains/payroll/service';

/** GET per-staff commission overrides. */
export const GET = route({
  auth: 'tenant', capability: 'payroll.view',
  handler: async ({ tenant }) => ({ data: await listCommissionOverrides(tenant) }),
});
