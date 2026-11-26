import { z } from 'zod';
import { route } from '@/server/http/route';
import { marketObservationInput, radarApi } from '@/loom';
import { LOOM_FEATURE, LOOM_MANAGE, LOOM_VIEW, loomCtx } from '@/server/loom-host/access';
import '@/server/loom-host/radar';

/** GET /loom/market-observations?archived=1 — observations with comparability and per-offering price context (context only, T15). */
export const GET = route({
  auth: 'tenant', capability: LOOM_VIEW, feature: LOOM_FEATURE, input: z.object({ archived: z.enum(['0', '1']).optional() }).strict(),
  handler: async ({ tenant, locale, input }) => ({ data: await radarApi.getMarket({ businessId: tenant.tenantId, locale }, input.archived === '1') }),
});

/** POST — a manual observation, or from a link (fetched through the SSRF-safe fetcher; its text is stored as untrusted). */
export const POST = route({
  auth: 'tenant', capability: LOOM_MANAGE, feature: LOOM_FEATURE, input: marketObservationInput, idempotency: 'optional',
  handler: async ({ tenant, actor, locale, input }) => ({ status: 201, data: await radarApi.createMarketObservation(loomCtx(tenant, actor, locale), input) }),
});
