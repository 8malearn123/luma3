import { platformRoute } from '@/server/domains/platform/guard';
import { revenue } from '@/server/domains/platform/reports';
import { revenueQuery } from '@/shared/schemas/platform';

/** GET /api/v1/platform/revenue — LUMA subscription revenue (test), separate from salon sales. */
export const GET = platformRoute({
  platformCapability: 'platform.revenue.view', input: revenueQuery,
  handler: async ({ input }) => ({ data: await revenue(input) }),
});
