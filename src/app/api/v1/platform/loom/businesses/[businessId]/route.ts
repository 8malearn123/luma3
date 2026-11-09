import { z } from 'zod';
import { platformRoute } from '@/server/domains/platform/guard';
import { loomApi, loomBusinesses, loomConnections } from '@/loom';

/** GET — the external business, its connections (no secrets), analyses and data quality. */
export const GET = platformRoute({
  platformCapability: 'platform.loom.manage',
  handler: async ({ params, locale }) => {
    const id = await loomBusinesses.resolveExternal(params.businessId!);
    return { data: {
      business: await loomBusinesses.getExternal(id), connections: await loomConnections.list({ businessId: id }),
      analyses: await loomApi.listAnalyses({ businessId: id, locale }), data_quality: await loomApi.getDataQuality({ businessId: id, locale }),
    } };
  },
});

/** PATCH — name, pack (enabled only), timezone, currency, status. */
export const PATCH = platformRoute({
  platformCapability: 'platform.loom.manage', input: loomBusinesses.externalBusinessPatch,
  handler: async ({ params, actor, input }) => ({ data: await loomBusinesses.updateExternal(actor, await loomBusinesses.resolveExternal(params.businessId!), input) }),
});

/** POST { action: 'analyze' } — queues an analysis (fails with connection_review_required until a connection is approved). */
export const POST = platformRoute({
  platformCapability: 'platform.loom.manage', input: z.object({ action: z.literal('analyze') }).strict(),
  rateLimit: { scope: 'user', limit: 60, windowSec: 3600, name: 'loom-external-analyses' },
  handler: async ({ params, actor }) => {
    const r = await loomBusinesses.startExternalAnalysis(actor, await loomBusinesses.resolveExternal(params.businessId!));
    return { status: r.created ? 202 : 200, data: r };
  },
});
