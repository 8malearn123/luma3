import { route } from '@/server/http/route';
import { listPayProfiles } from '@/server/domains/payroll/service';

/** GET each staff member's monthly base salary. */
export const GET = route({ auth: 'tenant', capability: 'payroll.view', handler: async ({ tenant }) => ({ data: await listPayProfiles(tenant) }) });
