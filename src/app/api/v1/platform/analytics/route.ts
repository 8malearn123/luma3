import { platformRoute } from '@/server/domains/platform/guard';
import { analyticsCsvRows, platformAnalytics } from '@/server/domains/platform/insights';
import { csvResponse } from '@/server/domains/platform/export';
import { periodQuery } from '@/shared/schemas/admin';

/** GET /api/v1/platform/analytics?from&to[&format=csv] — platform-wide analytics (aggregates only). */
export const GET = platformRoute({
  platformCapability: 'platform.analytics.view', input: periodQuery,
  handler: async ({ input, actor }) => {
    const a = await platformAnalytics(input);
    if (input.format === 'csv') return csvResponse(actor, 'analytics', `luma-analytics-${a.period.from}_${a.period.to}.csv`, analyticsCsvRows(a), undefined, { from: a.period.from, to: a.period.to });
    return { data: a };
  },
});
