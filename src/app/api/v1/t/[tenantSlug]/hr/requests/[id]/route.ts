import { route } from '@/server/http/route';
import { requireArea } from '@/server/tenancy/workspace-mode';
import { requireUuidParam } from '@/server/http/params';
import { getRequest } from '@/server/domains/hr/requests';

/** GET a request with its full approval history. */
export const GET = route({
  auth: 'tenant', capability: ['hr.request', 'hr.configure', 'leave.approve', 'schedule.manage'],
  handler: async ({ tenant, params }) => {
    requireArea(tenant, 'team_admin');
    return { data: await getRequest(tenant, requireUuidParam(params, 'id')) };
  },
});
