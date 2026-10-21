import { z } from 'zod';
import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { rejectProposal } from '@/server/domains/builder/assistant';

export const POST = route({
  auth: 'tenant', capability: 'builder.edit', input: z.object({}).strict(),
  handler: async ({ tenant, actor, params }) => ({ data: await rejectProposal(tenant, actor, requireUuidParam(params, 'id')) }),
});
