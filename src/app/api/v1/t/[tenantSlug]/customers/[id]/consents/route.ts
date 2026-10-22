import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { recordCustomerConsent } from '@/server/domains/customers/service';
import { consentInput } from '@/shared/schemas/customers';

/** POST — records a consent grant/withdrawal (append-only history). */
export const POST = route({
  auth: 'tenant', capability: 'customers.manage', input: consentInput,
  handler: async ({ tenant, actor, params, input }) => ({ status: 201, data: await recordCustomerConsent(tenant, actor, requireUuidParam(params, 'id'), input) }),
});
