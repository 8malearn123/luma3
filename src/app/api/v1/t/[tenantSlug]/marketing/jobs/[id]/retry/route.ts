import { z } from 'zod';
import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { retryJob } from '@/server/domains/marketing/service';


export const POST = route({
  auth: 'tenant', capability: 'marketing.manage', feature: 'feature.marketing_ai',
  input: z.object({ mode: z.enum(['auto', 'rules']).optional() }).strict(),
  handler: async ({ tenant, actor, params, input }) => ({ status: 202, data: await retryJob(tenant, actor, requireUuidParam(params, 'id'), input.mode) }),
});
