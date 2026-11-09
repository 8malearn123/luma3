import { route } from '@/server/http/route';
import { listStaffFiles } from '@/server/domains/hr/files';

/** GET every staff file summary (owner only). */
export const GET = route({
  auth: 'tenant', capability: 'staff_file.manage',
  handler: async ({ tenant }) => ({ data: await listStaffFiles(tenant) }),
});
