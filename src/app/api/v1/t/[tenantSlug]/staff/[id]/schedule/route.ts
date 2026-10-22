import { z } from 'zod';
import { route } from '@/server/http/route';
import { getSchedule, setWeeklyHours } from '@/server/domains/schedule/service';
import { weeklyHoursInput } from '@/shared/schemas/team';
import { requireUuidParam } from '@/server/http/params';

export const GET = route({
  auth: 'tenant', capability: ['schedule.manage', 'schedule.view_own'],
  input: z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }),
  handler: async ({ tenant, params, input }) => ({ data: await getSchedule(tenant, requireUuidParam(params, 'id'), input.from && input.to ? { from: input.from, to: input.to } : undefined) }),
});
export const PUT = route({
  auth: 'tenant', capability: 'schedule.manage', input: weeklyHoursInput,
  handler: async ({ tenant, actor, params, input }) => ({ data: await setWeeklyHours(tenant, actor, requireUuidParam(params, 'id'), input) }),
});
