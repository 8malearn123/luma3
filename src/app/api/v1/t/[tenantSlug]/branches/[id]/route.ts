import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { updateBranch } from '@/server/domains/settings/branches';
import { branchPatch } from '@/shared/schemas/settings';

/** PATCH /api/v1/t/:slug/branches/:id — edit, hours, set primary, archive/restore (never delete). */
export const PATCH = route({
  auth: 'tenant', capability: 'business.manage', input: branchPatch,
  handler: async ({ tenant, actor, params, input }) => ({ data: await updateBranch(tenant, actor, requireUuidParam(params, 'id'), input) }),
});
