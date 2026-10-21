import { z } from 'zod';
import { route } from '@/server/http/route';
import { createSession, listSessions } from '@/server/domains/groups/service';
import { groupSessionInput } from '@/shared/schemas/waitlist';

export const GET = route({
  auth: 'tenant', capability: ['bookings.view_all', 'bookings.manage'], feature: 'feature.group_sessions',
  input: z.object({ from: z.string().datetime({ offset: true }).optional(), to: z.string().datetime({ offset: true }).optional() }),
  handler: async ({ tenant, input }) => ({ data: await listSessions(tenant.tenantId, { from: input.from ? new Date(input.from) : new Date(Date.now() - 7 * 86_400_000), to: input.to ? new Date(input.to) : new Date(Date.now() + 60 * 86_400_000) }) }),
});
export const POST = route({
  auth: 'tenant', capability: 'bookings.manage', feature: 'feature.group_sessions', input: groupSessionInput,
  handler: async ({ tenant, actor, input }) => ({ status: 201, data: await createSession(tenant, actor, input) }),
});
