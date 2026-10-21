import { z } from 'zod';
import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { exportPlan } from '@/server/domains/marketing/plans';


/** Download as JSON or CSV (formula-injection safe). */
export const GET = route({
  auth: 'tenant', capability: ['marketing.view', 'marketing.manage'], feature: 'feature.marketing_ai',
  input: z.object({ format: z.enum(['json', 'csv']).default('json'), version: z.coerce.number().int().min(1).optional() }).strict(),
  handler: async ({ tenant, params, input }) => {
    const f = await exportPlan(tenant, requireUuidParam(params, 'id'), input.format, input.version);
    return new Response(f.body, { status: 200, headers: { 'Content-Type': f.mime, 'Content-Disposition': `attachment; filename="${f.filename}"`, 'X-Content-Type-Options': 'nosniff' } });
  },
});
