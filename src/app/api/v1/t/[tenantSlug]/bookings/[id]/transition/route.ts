import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { transition } from '@/server/domains/booking/service';
import { transitionInput } from '@/shared/schemas/booking';

/** POST { action, reason?, version? } — the server transition table decides (roles, guards, side effects). */
export const POST = route({
  auth: 'tenant', capability: ['bookings.manage', 'bookings.manage_assigned'], input: transitionInput,
  handler: async ({ tenant, params, input, actor }) => ({
    data: await transition(tenant.tenantId, requireUuidParam(params, 'id'), input.action, { kind: 'staff', access: tenant, audit: actor }, { reason: input.reason, expectedVersion: input.version }),
  }),
});
