import { route } from '@/server/http/route';
import { branchScopeFor } from '@/server/domains/business/branch-scope';
import { businessOverview } from '@/server/domains/business/overview';

/** Workspace overview for any member; each section is gated by capability inside the service. */
export const GET = route({
  auth: 'tenant',
  handler: async ({ tenant, req, user }) => {
    const scope = await branchScopeFor(req, tenant);
    return { data: { ...(await businessOverview(tenant, { branchIds: scope.branchIds, userName: user.displayName })), branch: { selected: scope.selected, restricted: scope.restricted } } };
  },
});
