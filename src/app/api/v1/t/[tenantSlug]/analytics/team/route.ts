import { route } from '@/server/http/route';
import { teamPerformance } from '@/server/domains/analytics/performance';
import { periodQuery } from '@/shared/schemas/marketing';

/** analytics.view sees the team; a specialist with a staff profile sees only herself (enforced in the service). */
export const GET = route({
  auth: 'tenant', capability: ['analytics.view', 'schedule.view_own'], input: periodQuery,
  handler: async ({ tenant, input }) => ({ data: await teamPerformance(tenant, input) }),
});
