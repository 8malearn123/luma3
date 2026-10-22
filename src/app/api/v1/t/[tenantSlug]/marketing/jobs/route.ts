import { z } from 'zod';
import { route } from '@/server/http/route';
import { Errors } from '@/server/http/errors';
import { listJobs, requestJob } from '@/server/domains/marketing/service';
import { aiJobInput } from '@/shared/schemas/marketing';


export const GET = route({
  auth: 'tenant', capability: ['marketing.view', 'marketing.manage'], feature: 'feature.marketing_ai',
  handler: async ({ tenant }) => ({ data: await listJobs(tenant) }),
});

/** Queues an analysis (idempotent per tenant/kind/period: an existing live job is returned). */
export const POST = route({
  auth: 'tenant', capability: 'marketing.manage', feature: 'feature.marketing_ai',
  input: aiJobInput.extend({ mode: z.enum(['auto', 'rules']).optional() }).strict(),
  rateLimit: { scope: 'user', limit: 30, windowSec: 3600, name: 'loom-jobs' },
  handler: async ({ tenant, actor, input }) => {
    if (input.kind === 'employee_insights') throw Errors.invalid('use_team_insights_endpoint');
    const r = await requestJob(tenant, actor, input);
    return { status: r.created ? 202 : 200, data: r };
  },
});
