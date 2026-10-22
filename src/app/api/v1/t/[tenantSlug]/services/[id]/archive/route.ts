import { z } from 'zod';
import { route } from '@/server/http/route';
import { archiveService } from '@/server/domains/catalog/service';
import { requireUuidParam } from '@/server/http/params';

/** POST { archived } — services are archived, never deleted (booking history references them). */
export const POST = route({
  auth: 'tenant', capability: 'catalog.edit', input: z.object({ archived: z.boolean() }),
  handler: async ({ tenant, actor, input, params }) => ({ data: await archiveService(tenant, actor, requireUuidParam(params, 'id'), input.archived) }),
});
