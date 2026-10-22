import { z } from 'zod';
import { route } from '@/server/http/route';
import { createBranch, listBranches } from '@/server/domains/settings/branches';
import { branchInput } from '@/shared/schemas/settings';

/** GET/POST /api/v1/t/:slug/branches — create within the plan's branch limit. */
export const GET = route({
  auth: 'tenant', capability: ['business.manage', 'schedule.manage', 'bookings.view_all', 'bookings.manage'],
  input: z.object({ include_archived: z.enum(['0', '1']).optional() }),
  handler: async ({ tenant, input }) => ({ data: await listBranches(tenant, input.include_archived !== '0') }),
});
export const POST = route({
  auth: 'tenant', capability: 'business.manage', input: branchInput,
  handler: async ({ tenant, actor, input }) => ({ status: 201, data: await createBranch(tenant, actor, input) }),
});
