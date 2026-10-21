import { z } from 'zod';
import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { restoreToDraft } from '@/server/domains/builder/publish';

/** POST — copy a version back into the drafts without publishing. */
export const POST = route({
  auth: 'tenant', capability: 'builder.edit', input: z.object({}).strict(),
  handler: async ({ tenant, actor, params }) => ({ data: await restoreToDraft(tenant, actor, requireUuidParam(params, 'versionId')) }),
});
