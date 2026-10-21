import { z } from 'zod';
import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { regeneratePlan } from '@/server/domains/marketing/service';


/** Queues a new analysis that appends a version; the approved version is untouched. */
export const POST = route({
  auth: 'tenant', capability: 'marketing.manage', feature: 'feature.marketing_ai',
  input: z.object({ mode: z.enum(['auto', 'rules']).optional() }).strict(),
  rateLimit: { scope: 'user', limit: 20, windowSec: 3600, name: 'loom-regenerate' },
  handler: async ({ tenant, actor, params, input }) => {
    const r = await regeneratePlan(tenant, actor, requireUuidParam(params, 'id'), input.mode);
    return { status: r.created ? 202 : 200, data: r };
  },
});
