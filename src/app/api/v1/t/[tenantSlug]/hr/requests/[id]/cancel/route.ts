import { z } from 'zod';
import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { cancelRequest } from '@/server/domains/hr/requests';

/** POST cancel my own request while it is pending. */
export const POST = route({
  auth: 'tenant', input: z.object({ note: z.string().trim().max(1000).optional() }).strict(),
  handler: async ({ tenant, actor, params, input }) => ({ data: await cancelRequest(tenant, actor, requireUuidParam(params, 'id'), input.note) }),
});
