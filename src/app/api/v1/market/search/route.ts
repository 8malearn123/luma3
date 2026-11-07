import { route } from '@/server/http/route';
import { searchMarketplace } from '@/server/domains/marketplace/directory';
import { marketSearchQuery } from '@/shared/schemas/marketplace';

/**
 * GET /api/v1/market/search — سوق لوما search (public). Only listed businesses
 * (approved, visible, active, published, verified when required) and public
 * card fields are returned; businesses are identified by slug.
 */
export const GET = route({
  auth: 'optional', input: marketSearchQuery,
  rateLimit: { scope: 'ip', name: 'market_search', limit: 120, windowSec: 60 },
  handler: async ({ input, user }) => ({ data: await searchMarketplace(input, user?.userId) }),
});
