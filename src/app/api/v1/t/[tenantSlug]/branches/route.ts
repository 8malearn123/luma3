import { z } from 'zod';
import { route } from '@/server/http/route';
import { createBranch, listBranches } from '@/server/domains/settings/branches';
import { branchInput } from '@/shared/schemas/settings';
import { requireArea } from '@/server/tenancy/workspace-mode';

/** GET/POST /api/v1/t/:slug/branches — create within the plan's branch limit. */
export const GET = route({
  auth: 'tenant', capability: ['business.manage', 'schedule.manage', 'bookings.view_all', 'bookings.manage'],
  input: z.object({ include_archived: z.enum(['0', '1']).optional() }),
  handler: async ({ tenant, input }) => ({ data: await listBranches(tenant, input.include_archived !== '0') }),
});
export const POST = route({
  auth: 'tenant', capability: 'business.manage', input: branchInput,
  handler: async ({ tenant, actor, input }) => {
    // R5: a solo freelancer works from one studio (no second branch until she has an assistant).
    requireArea(tenant, 'branches_multi');
    return { status: 201, data: await createBranch(tenant, actor, input) };
  },
});
