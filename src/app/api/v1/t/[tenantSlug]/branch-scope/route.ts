import { route } from '@/server/http/route';
import { branchCookieName, branchSwitcherData } from '@/server/domains/business/branch-scope';

/** Branches the header switcher offers this member, and her current selection (any member). */
export const GET = route({
  auth: 'tenant',
  handler: async ({ tenant, req }) => ({ data: await branchSwitcherData(tenant, req.cookies.get(branchCookieName(tenant.slug))?.value ?? null) }),
});
