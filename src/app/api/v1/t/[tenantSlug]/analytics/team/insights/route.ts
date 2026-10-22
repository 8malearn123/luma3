import { route } from '@/server/http/route';
import { withTenant } from '@/server/db/client';
import { Errors } from '@/server/http/errors';
import { requireFeature } from '@/server/tenancy/access';
import { requestAiJob } from '@/server/domains/marketing/pipeline';


/**
 * AI explanations of computed team indicators (development ideas only, never
 * employment decisions). Managers/owners only; specialists never see colleagues.
 */
export const GET = route({
  auth: 'tenant', capability: 'analytics.view',
  handler: async ({ tenant }) => {
    if (tenant.role === 'specialist') throw Errors.forbidden();
    const job = await withTenant(tenant.tenantId, (trx) => trx.selectFrom('ai_jobs').select(['id', 'status', 'error_code', 'result_ref', 'finished_at', 'created_at'])
      .where('kind', '=', 'employee_insights').orderBy('created_at', 'desc').executeTakeFirst());
    return { data: job ?? null };
  },
});

export const POST = route({
  auth: 'tenant', capability: 'analytics.view',
  rateLimit: { scope: 'user', limit: 10, windowSec: 3600, name: 'team-insights' },
  handler: async ({ tenant, actor }) => {
    if (tenant.role === 'specialist') throw Errors.forbidden();
    requireFeature(tenant, 'feature.marketing_ai');
    const r = await requestAiJob(tenant.tenantId, { kind: 'employee_insights', trigger: 'manual', requestedBy: actor.userId });
    return { status: r.created ? 202 : 200, data: r };
  },
});
