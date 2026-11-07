import { route } from '@/server/http/route';
import { requestListing } from '@/server/domains/marketplace/listing';

/** POST — ask LUMA to list the business in سوق لوما (reviewed by a LUMA admin). */
export const POST = route({
  auth: 'tenant', capability: 'business.manage', rateLimit: { scope: 'user', name: 'market_request', limit: 10, windowSec: 3600 },
  handler: async ({ tenant, actor }) => ({ data: await requestListing(tenant, actor) }),
});
