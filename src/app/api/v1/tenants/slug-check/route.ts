import { z } from 'zod';
import { route } from '@/server/http/route';
import { slugAvailable } from '@/server/domains/tenants/service';
import { suggestSlug, zSlug } from '@/shared/onboarding';

/** GET /api/v1/tenants/slug-check?slug=…|name=… */
export const GET = route({
  auth: 'user',
  input: z.object({ slug: zSlug.optional(), name: z.string().max(120).optional() }),
  rateLimit: { scope: 'user', name: 'slug_check', limit: 60, windowSec: 60 },
  handler: async ({ input }) => {
    const slug = input.slug ?? (input.name ? suggestSlug(input.name) : null);
    if (!slug) return { data: { slug: null, available: false } };
    return { data: { slug, available: await slugAvailable(slug) } };
  },
});
