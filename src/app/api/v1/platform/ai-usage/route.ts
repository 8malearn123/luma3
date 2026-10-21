import { platformRoute } from '@/server/domains/platform/guard';
import { aiUsage } from '@/server/domains/platform/reports';
import { aiUsageQuery } from '@/shared/schemas/platform';

/** GET /api/v1/platform/ai-usage — runs/tokens per business and month; cost only where recorded. */
export const GET = platformRoute({
  platformCapability: 'platform.ai_usage.view', input: aiUsageQuery,
  handler: async ({ input }) => ({ data: await aiUsage(input) }),
});
