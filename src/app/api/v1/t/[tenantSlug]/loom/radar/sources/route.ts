import { route } from '@/server/http/route';
import { radarApi, signalSourceInput } from '@/loom';
import { LOOM_FEATURE, LOOM_MANAGE, loomCtx } from '@/server/loom-host/access';
import '@/server/loom-host/radar';

/** POST /loom/radar/sources — rss | user_link (SSRF-checked) | api (provider; «غير متصل» when not configured). Fetches once. */
export const POST = route({
  auth: 'tenant', capability: LOOM_MANAGE, feature: LOOM_FEATURE, input: signalSourceInput, idempotency: 'optional',
  handler: async ({ tenant, actor, locale, input }) => ({ status: 201, data: await radarApi.createSource(loomCtx(tenant, actor, locale), input) }),
});
