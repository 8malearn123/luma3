import { z } from 'zod';
import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { cancelSession } from '@/server/domains/groups/service';

export const POST = route({
  auth: 'tenant', capability: 'bookings.manage', input: z.object({ reason: z.string().trim().min(3).max(300) }),
  handler: async ({ tenant, actor, params, input }) => ({ data: await cancelSession(tenant, actor, requireUuidParam(params, 'id'), input.reason) }),
});
