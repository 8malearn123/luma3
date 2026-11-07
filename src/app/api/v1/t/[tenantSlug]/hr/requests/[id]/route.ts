import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { getRequest } from '@/server/domains/hr/requests';

/** GET a request with its full approval history. */
export const GET = route({
  auth: 'tenant', capability: ['hr.request', 'hr.configure', 'leave.approve', 'schedule.manage'],
  handler: async ({ tenant, params }) => ({ data: await getRequest(tenant, requireUuidParam(params, 'id')) }),
});
