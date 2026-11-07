import { z } from 'zod';
import { route } from '@/server/http/route';
import { getInstagramSettings, setInstagramHandle } from '@/server/domains/instagram/service';

/** Instagram section settings: the handle (profile link) and the official connection status. Tokens are never returned. */
export const GET = route({
  auth: 'tenant', capability: ['builder.edit', 'business.manage'],
  handler: async ({ tenant }) => ({ data: await getInstagramSettings(tenant) }),
});
export const PUT = route({
  auth: 'tenant', capability: ['builder.edit', 'business.manage'], input: z.object({ handle: z.string().trim().max(120).nullable() }).strict(),
  handler: async ({ tenant, actor, input }) => ({ data: await setInstagramHandle(tenant, actor, input.handle) }),
});
