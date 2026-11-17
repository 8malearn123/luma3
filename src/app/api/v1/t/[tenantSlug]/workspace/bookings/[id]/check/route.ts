import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { guestCheck } from '@/server/domains/hosting/bookings';
import { z } from 'zod';
/** Check-in / check-out with the code given at the salon reception (D8). */
export const POST = route({
  auth: 'tenant', capability: 'workspace.book', feature: 'workspace.book', input: z.object({ action: z.enum(['in', 'out']), code: z.string().regex(/^\d{6}$/) }).strict(),
  handler: async ({ tenant, actor, params, input }) => ({ data: await guestCheck(tenant, actor, requireUuidParam(params, 'id'), input.action, input.code) }),
});
