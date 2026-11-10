import { z } from 'zod';
import { route } from '@/server/http/route';
import { scanQr } from '@/server/domains/hosting/bookings';

/** Reception scans the expert's QR: check-in when confirmed, otherwise check-out. */
export const POST = route({
  auth: 'tenant', capability: ['hosting.manage', 'bookings.manage'], input: z.object({ token: z.string().min(20).max(80) }).strict(),
  handler: async ({ tenant, actor, input }) => ({ data: await scanQr(tenant, actor, input.token) }),
});
