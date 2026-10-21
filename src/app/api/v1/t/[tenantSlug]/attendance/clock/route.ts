import { z } from 'zod';
import { route } from '@/server/http/route';
import { clock } from '@/server/domains/schedule/service';

export const POST = route({
  auth: 'tenant', capability: ['attendance.own', 'attendance.manage'],
  input: z.object({ kind: z.enum(['clock_in', 'clock_out']), staff_id: z.string().uuid().optional(), note: z.string().max(200).optional() }),
  handler: async ({ tenant, actor, input }) => ({ status: 201, data: await clock(tenant, actor, input.kind, { staffId: input.staff_id, note: input.note }) }),
});
