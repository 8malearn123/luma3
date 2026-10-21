import { route } from '@/server/http/route';
import { withTenant } from '@/server/db/client';
import { computeOccupancy } from '@/server/domains/analytics/occupancy';
import { resolvePeriod } from '@/server/domains/analytics/period';
import { periodQuery } from '@/shared/schemas/marketing';

export const GET = route({
  auth: 'tenant', capability: 'analytics.view', input: periodQuery,
  handler: async ({ tenant, input }) => {
    const p = resolvePeriod(tenant.timezone, input.from, input.to, 30);
    const data = await withTenant(tenant.tenantId, (trx) => computeOccupancy(trx, tenant.tenantId, tenant.timezone, p.from, p.to, { staffIds: input.staff_id ? [input.staff_id] : undefined }));
    return { data };
  },
});
