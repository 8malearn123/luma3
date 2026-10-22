import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { getCustomer, updateCustomer } from '@/server/domains/customers/service';
import { customerPatch } from '@/shared/schemas/customers';

export const GET = route({
  auth: 'tenant', capability: 'customers.view',
  handler: async ({ tenant, params }) => ({ data: await getCustomer(tenant, requireUuidParam(params, 'id')) }),
});

/** PATCH — profile, tags, preferences, notes (customers.view_notes), archive (never delete). */
export const PATCH = route({
  auth: 'tenant', capability: 'customers.manage', input: customerPatch,
  handler: async ({ tenant, actor, params, input }) => ({ data: await updateCustomer(tenant, actor, requireUuidParam(params, 'id'), input) }),
});
