import { route } from '@/server/http/route';
import { loomBusinesses } from '@/loom';
import { LOOM_CONNECTIONS, LOOM_FEATURE, LOOM_VIEW, loomCtx } from '@/server/loom-host/access';

/** GET /loom/sector-pack — the business's pack, its vocabulary (UI labels) and the packs the platform enabled. */
export const GET = route({
  auth: 'tenant', capability: LOOM_VIEW, feature: LOOM_FEATURE,
  handler: async ({ tenant, locale }) => ({ data: await loomBusinesses.getSectorPack({ businessId: tenant.tenantId, locale }) }),
});

/** PUT { sector_pack } — only a platform-enabled pack (owner: business.manage). */
export const PUT = route({
  auth: 'tenant', capability: LOOM_CONNECTIONS, feature: LOOM_FEATURE, input: loomBusinesses.sectorPackInput,
  handler: async ({ tenant, actor, locale, input }) => ({ data: await loomBusinesses.setSectorPack({ ...loomCtx(tenant, actor, locale), name: tenant.name }, input.sector_pack) }),
});
