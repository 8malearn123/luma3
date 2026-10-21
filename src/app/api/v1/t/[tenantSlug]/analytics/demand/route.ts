import { route } from '@/server/http/route';
import { demandReport } from '@/server/domains/analytics/metrics';
import { periodQuery } from '@/shared/schemas/marketing';

export const GET = route({
  auth: 'tenant', capability: 'analytics.view', input: periodQuery,
  handler: async ({ tenant, input }) => ({ data: await demandReport(tenant, input) }),
});
