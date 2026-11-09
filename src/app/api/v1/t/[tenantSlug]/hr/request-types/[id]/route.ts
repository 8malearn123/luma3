import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { requestTypePatch, updateRequestType } from '@/server/domains/hr/requests';

/** PATCH name, approval chain, fields, active flag or order of a request type. */
export const PATCH = route({
  auth: 'tenant', capability: 'hr.configure', input: requestTypePatch,
  handler: async ({ tenant, actor, params, input }) => ({ data: await updateRequestType(tenant, actor, requireUuidParam(params, 'id'), input) }),
});
