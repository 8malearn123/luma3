import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { hostCheck } from '@/server/domains/hosting/bookings';
import { z } from 'zod';
/** Reception records check-in / check-out (manual). */
export const POST = route({
  auth: 'tenant', capability: ['hosting.manage', 'bookings.manage'], input: z.object({ action: z.enum(['in', 'out']) }).strict(),
  handler: async ({ tenant, actor, params, input }) => ({ data: await hostCheck(tenant, actor, requireUuidParam(params, 'id'), input.action) }),
});
