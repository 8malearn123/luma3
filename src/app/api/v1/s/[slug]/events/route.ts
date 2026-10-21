import { route } from '@/server/http/route';
import { env } from '@/server/env';
import { ingestEvent } from '@/server/domains/analytics/events';
import { eventInput } from '@/shared/schemas/marketing';

/**
 * Public storefront analytics ingestion. CSRF header required (sent by the
 * storefront client util), rate-limited per IP, tenant from the slug only.
 * Responds 202 for stored, duplicate and excluded events alike so the browser
 * learns nothing about exclusion rules.
 */
export const POST = route({
  auth: 'optional',
  input: eventInput,
  rateLimit: { scope: 'ip', limit: 240, windowSec: 60, name: 'storefront-events' },
  handler: async ({ params, input, user, userAgent, req }) => {
    const ownHosts = [new URL(env().APP_URL).hostname, req.nextUrl.hostname].map((h) => h.toLowerCase());
    await ingestEvent(params.slug ?? '', input, { user, userAgent, pageReferer: req.headers.get('referer'), ownHosts });
    return { status: 202, data: { accepted: true } };
  },
});
