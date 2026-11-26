import { route } from '@/server/http/route';
import { loomModels, versionsQuery } from '@/loom';
import { LOOM_FEATURE, LOOM_VIEW } from '@/server/loom-host/access';

/** GET /loom/models/versions?kind= — the model registry of the business (training window + data hash, split T, metrics vs baseline, gate, shadow result). */
export const GET = route({
  auth: 'tenant', capability: LOOM_VIEW, feature: LOOM_FEATURE, input: versionsQuery,
  handler: async ({ tenant, locale, input }) => ({ data: await loomModels.listVersions({ businessId: tenant.tenantId, locale }, input.kind) }),
});
