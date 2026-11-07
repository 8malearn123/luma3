import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { cancelEvent } from '@/server/domains/events/service';
import { eventReasonInput } from '@/shared/schemas/events';

/** POST business cancellation: everything paid is refunded (system-approved refunds). */
export const POST = route({
  auth: 'tenant', capability: 'bookings.manage', input: eventReasonInput,
  handler: async ({ tenant, actor, params, input }) => ({ data: await cancelEvent(tenant.tenantId, requireUuidParam(params, 'id'), { kind: 'business', access: tenant, audit: actor }, input.reason) }),
});
