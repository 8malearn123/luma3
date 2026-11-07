import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { declineRequest } from '@/server/domains/events/service';
import { eventReasonInput } from '@/shared/schemas/events';

export const POST = route({
  auth: 'tenant', capability: 'bookings.manage', input: eventReasonInput,
  handler: async ({ tenant, actor, params, input }) => ({ data: await declineRequest(tenant, actor, requireUuidParam(params, 'id'), input.reason) }),
});
