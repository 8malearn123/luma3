import { route } from '@/server/http/route';
import { readEventSettings, updateEventSettings } from '@/server/domains/events/service';
import { eventSettingsInput } from '@/shared/schemas/events';

export const GET = route({
  auth: 'tenant', capability: ['bookings.view_all', 'bookings.manage'],
  handler: async ({ tenant }) => ({ data: await readEventSettings(tenant.tenantId) }),
});
export const PUT = route({
  auth: 'tenant', capability: 'business.manage', input: eventSettingsInput,
  handler: async ({ tenant, actor, input }) => ({ data: await updateEventSettings(tenant, actor, input) }),
});
