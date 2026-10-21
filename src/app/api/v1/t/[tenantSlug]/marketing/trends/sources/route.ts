import { route } from '@/server/http/route';
import { addSource, listSources } from '@/server/domains/marketing/trends';
import { trendSourceInput } from '@/shared/schemas/marketing';


export const GET = route({
  auth: 'tenant', capability: ['marketing.view', 'marketing.manage'], feature: 'feature.marketing_ai',
  handler: async ({ tenant }) => ({ data: await listSources(tenant) }),
});

/** Adds an RSS feed or a user-provided link and fetches it through the SSRF-safe fetcher. */
export const POST = route({
  auth: 'tenant', capability: 'marketing.manage', feature: 'feature.marketing_ai', input: trendSourceInput,
  rateLimit: { scope: 'user', limit: 20, windowSec: 3600, name: 'trend-sources' },
  handler: async ({ tenant, actor, input }) => ({ status: 201, data: await addSource(tenant, actor, input) }),
});
