import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { withTenant } from '@/server/db/client';
import { assessTrends, fetchSource } from '@/server/domains/marketing/trends';


export const POST = route({
  auth: 'tenant', capability: 'marketing.manage', feature: 'feature.marketing_ai',
  rateLimit: { scope: 'user', limit: 30, windowSec: 3600, name: 'trend-fetch' },
  handler: async ({ tenant, params }) => {
    const r = await fetchSource(tenant.tenantId, requireUuidParam(params, 'id'));
    const a = await withTenant(tenant.tenantId, (trx) => assessTrends(trx, tenant.tenantId));
    return { data: { fetch: r, assessment: a } };
  },
});
