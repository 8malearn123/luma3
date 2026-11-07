import { route } from '@/server/http/route';
import { sessionFromRequest } from '@/server/domains/analytics/events';
import { recordMarketplaceVisit } from '@/server/domains/marketplace/attribution';

/**
 * POST /api/v1/s/{slug}/market-visit — the storefront was opened from سوق لوما
 * (header x-luma-session carries the pseudonymous analytics session). Bookings
 * this session places here are tagged as marketplace bookings.
 */
export const POST = route({
  auth: 'optional',
  rateLimit: { scope: 'ip', name: 'market_visit', limit: 60, windowSec: 60 },
  handler: async ({ params, req }) => ({ status: 202, data: await recordMarketplaceVisit(params.slug ?? '', sessionFromRequest(req)) }),
});
