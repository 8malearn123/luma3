import { platformRoute } from '@/server/domains/platform/guard';
import { loomPlannerApi } from '@/loom';

/** GET /api/v1/platform/loom/knowledge — the curated knowledge library (read-only), with review flags and citation counts. */
export const GET = platformRoute({
  platformCapability: 'platform.loom.manage',
  handler: async ({ locale }) => ({ data: await loomPlannerApi.platformKnowledge(locale === 'en' ? 'en' : 'ar', new Date().toISOString().slice(0, 10)) }),
});
