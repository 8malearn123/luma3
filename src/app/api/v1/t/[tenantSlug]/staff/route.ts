import { z } from 'zod';
import { route } from '@/server/http/route';
import { createStaff, listStaff } from '@/server/domains/team/service';
import { staffInput } from '@/shared/schemas/team';

export const GET = route({
  auth: 'tenant', capability: ['staff.edit', 'schedule.manage', 'bookings.view_all', 'bookings.manage', 'catalog.edit'],
  input: z.object({ include_archived: z.enum(['0', '1']).optional() }),
  handler: async ({ tenant, input }) => ({ data: await listStaff(tenant, { includeArchived: input.include_archived === '1' }) }),
});
export const POST = route({
  auth: 'tenant', capability: 'staff.edit', input: staffInput,
  handler: async ({ tenant, actor, input }) => ({ status: 201, data: await createStaff(tenant, actor, input) }),
});
