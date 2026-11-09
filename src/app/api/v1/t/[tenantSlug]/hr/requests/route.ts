import { route } from '@/server/http/route';
import { listRequests, listRequestsInput, submitRequest, submitRequestInput } from '@/server/domains/hr/requests';

/** GET requests: mine, my approval inbox, or all I may see. */
export const GET = route({
  auth: 'tenant', capability: ['hr.request', 'hr.configure', 'leave.approve', 'schedule.manage'], input: listRequestsInput,
  handler: async ({ tenant, input }) => ({ data: await listRequests(tenant, input) }),
});
/** POST submit a request (leave, advance, letter or custom). */
export const POST = route({
  auth: 'tenant', capability: ['hr.request', 'schedule.manage'], input: submitRequestInput,
  handler: async ({ tenant, actor, input }) => ({ status: 201, data: await submitRequest(tenant, actor, input) }),
});
