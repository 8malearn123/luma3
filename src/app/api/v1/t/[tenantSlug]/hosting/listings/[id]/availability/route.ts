import { z } from 'zod';
import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { hostAvailability } from '@/server/domains/hosting/listings';

/** Internal vs rentable view of one day. */
export const GET = route({
  auth: 'tenant', capability: ['hosting.view', 'hosting.manage'], input: z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
  handler: async ({ tenant, params, input }) => ({ data: await hostAvailability(tenant, requireUuidParam(params, 'id'), input.date) }),
});
