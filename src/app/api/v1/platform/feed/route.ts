import { platformRoute } from '@/server/domains/platform/guard';
import { platformFeed } from '@/server/domains/platform/activity';
import { feedQuery } from '@/shared/schemas/admin';

/** GET /api/v1/platform/feed?since= — live cross-tenant activity summaries (polled by the bell and /platform/feed). */
export const GET = platformRoute({
  platformCapability: 'platform.feed.view', input: feedQuery,
  handler: async ({ input }) => ({ data: await platformFeed(input) }),
});
