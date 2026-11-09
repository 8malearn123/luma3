import { route } from '@/server/http/route';
import { withTenant } from '@/server/db/client';
import { teamPerformance } from '@/server/domains/analytics/performance';
import { branchScopeFor, staffInBranches } from '@/server/domains/business/branch-scope';
import { periodQuery } from '@/shared/schemas/marketing';

/** analytics.view sees the team; a specialist with a staff profile sees only herself (enforced in the service). Branch switcher narrows the rows. */
export const GET = route({
  auth: 'tenant', capability: ['analytics.view', 'schedule.view_own'], input: periodQuery,
  handler: async ({ tenant, input, req }) => {
    const data = await teamPerformance(tenant, input);
    const scope = await branchScopeFor(req, tenant);
    if (!scope.branchIds || data.scope === 'self') return { data };
    const ids = new Set(await withTenant(tenant.tenantId, (trx) => staffInBranches(trx, scope.branchIds)) ?? []);
    return { data: { ...data, staff: data.staff.filter((s) => ids.has(s.staff_id)) } };
  },
});
