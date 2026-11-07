import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { getStaffFile, staffFileInput, updateStaffFile } from '@/server/domains/hr/files';

/** GET a staff file (owner only; the ID number is masked). */
export const GET = route({
  auth: 'tenant', capability: 'staff_file.manage',
  handler: async ({ tenant, params }) => ({ data: await getStaffFile(tenant, requireUuidParam(params, 'staffId')) }),
});
/** PUT the staff file fields (owner only). */
export const PUT = route({
  auth: 'tenant', capability: 'staff_file.manage', input: staffFileInput,
  handler: async ({ tenant, actor, params, input }) => ({ data: await updateStaffFile(tenant, actor, requireUuidParam(params, 'staffId'), input) }),
});
