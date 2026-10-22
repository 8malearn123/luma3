import { z } from 'zod';
import { route } from '@/server/http/route';
import { listLeave, requestLeave } from '@/server/domains/schedule/service';
import { leaveInput } from '@/shared/schemas/team';

export const GET = route({
  auth: 'tenant', capability: ['leave.approve', 'schedule.manage', 'leave.request'],
  input: z.object({ status: z.enum(['requested', 'approved', 'rejected', 'cancelled']).optional() }),
  handler: async ({ tenant, input }) => ({ data: await listLeave(tenant, input.status) }),
});
export const POST = route({
  auth: 'tenant', capability: ['leave.request', 'schedule.manage'], input: leaveInput,
  handler: async ({ tenant, actor, input }) => ({ status: 201, data: await requestLeave(tenant, actor, input) }),
});
