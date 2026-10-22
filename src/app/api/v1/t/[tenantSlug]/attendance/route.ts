import { z } from 'zod';
import { route } from '@/server/http/route';
import { attendance } from '@/server/domains/schedule/service';

export const GET = route({
  auth: 'tenant', capability: ['attendance.manage', 'attendance.own'],
  input: z.object({ staff_id: z.string().uuid().optional(), from: z.string().datetime({ offset: true }), to: z.string().datetime({ offset: true }) }),
  handler: async ({ tenant, input }) => ({ data: await attendance(tenant, input.staff_id ?? null, new Date(input.from), new Date(input.to)) }),
});
