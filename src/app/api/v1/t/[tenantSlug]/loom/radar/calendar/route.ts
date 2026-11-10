import { route } from '@/server/http/route';
import { radarApi, radarCalendarQuery } from '@/loom';
import { LOOM_FEATURE, LOOM_VIEW } from '@/server/loom-host/access';

/** GET /loom/radar/calendar?days= — upcoming relevant events: platform (verified / needs verification, adopted / hidden) and owner-verified. */
export const GET = route({
  auth: 'tenant', capability: LOOM_VIEW, feature: LOOM_FEATURE, input: radarCalendarQuery,
  handler: async ({ tenant, locale, input }) => ({ data: await radarApi.getCalendar({ businessId: tenant.tenantId, locale }, input.days) }),
});
