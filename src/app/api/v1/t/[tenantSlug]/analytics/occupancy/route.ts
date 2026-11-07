import { route } from '@/server/http/route';
import { withTenant } from '@/server/db/client';
import { computeOccupancy } from '@/server/domains/analytics/occupancy';
import { resolvePeriod } from '@/server/domains/analytics/period';
import { branchScopeFor, staffInBranches } from '@/server/domains/business/branch-scope';
import { periodQuery } from '@/shared/schemas/marketing';

export const GET = route({
  auth: 'tenant', capability: 'analytics.view', input: periodQuery,
  handler: async ({ tenant, input, req }) => {
    const p = resolvePeriod(tenant.timezone, input.from, input.to, 30);
    const scope = await branchScopeFor(req, tenant);
    const data = await withTenant(tenant.tenantId, async (trx) => {
      const inBranch = await staffInBranches(trx, scope.branchIds);
      let staffIds = input.staff_id ? [input.staff_id] : inBranch ?? undefined;
      if (input.staff_id && inBranch) staffIds = inBranch.includes(input.staff_id) ? [input.staff_id] : [];
      if (staffIds && !staffIds.length) return { from: p.from, to: p.to, timezone: tenant.timezone, staff: [], totals: { available_min: 0, booked_min: 0, booked_outside_min: 0, occupancy: null }, buckets: [] };
      return computeOccupancy(trx, tenant.tenantId, tenant.timezone, p.from, p.to, { staffIds });
    });
    return { data };
  },
});
