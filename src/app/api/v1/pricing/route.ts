import { z } from 'zod';
import { route } from '@/server/http/route';
import { publicPricing } from '@/server/domains/platform/pricing';

/** GET /api/v1/pricing[?promo=CODE] — public plan prices (monthly/yearly), founding seats left and running offers. */
export const GET = route({
  auth: 'public', input: z.object({ promo: z.string().trim().regex(/^[A-Za-z0-9_-]{3,32}$/).optional() }),
  rateLimit: { scope: 'ip', name: 'pricing', limit: 120, windowSec: 60 },
  handler: async ({ input }) => ({ data: await publicPricing(input) }),
});
