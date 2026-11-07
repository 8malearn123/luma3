import { route } from '@/server/http/route';
import { listBalances } from '@/server/domains/hr/balance';
import { ownStaffFile } from '@/server/domains/hr/files';

/** GET my non-sensitive staff file fields and my leave balance. */
export const GET = route({
  auth: 'tenant', capability: 'hr.request',
  handler: async ({ tenant }) => {
    const [file, balances] = await Promise.all([ownStaffFile(tenant), listBalances(tenant, tenant.staffProfileId ?? undefined)]);
    return { data: { file, balance: balances[0] ?? null } };
  },
});
