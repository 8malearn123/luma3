import { z } from 'zod';
import { route } from '@/server/http/route';
import { connectInstagram, disconnectInstagram } from '@/server/domains/instagram/service';

/**
 * POST connect the professional account with a token from the official
 * Instagram login (503 instagram_not_configured until the platform has a Meta app).
 */
export const POST = route({
  auth: 'tenant', capability: 'business.manage', input: z.object({ access_token: z.string().min(10).max(1000) }).strict(),
  rateLimit: { scope: 'user', name: 'instagram_connect', limit: 10, windowSec: 600 },
  handler: async ({ tenant, actor, input }) => ({ data: await connectInstagram(tenant, actor, input.access_token) }),
});
export const DELETE = route({
  auth: 'tenant', capability: 'business.manage',
  handler: async ({ tenant, actor }) => ({ data: await disconnectInstagram(tenant, actor) }),
});
