import { z } from 'zod';
import { route } from '@/server/http/route';
import { createManualPlan, listPlans } from '@/server/domains/marketing/plans';
import { createPlanInput } from '@/shared/schemas/marketing';


export const GET = route({
  auth: 'tenant', capability: ['marketing.view', 'marketing.manage'], feature: 'feature.marketing_ai',
  input: z.object({ kind: z.enum(['monthly', 'weekly']).optional() }).strict(),
  handler: async ({ tenant, input }) => ({ data: await listPlans(tenant, input.kind) }),
});

export const POST = route({
  auth: 'tenant', capability: 'marketing.manage', feature: 'feature.marketing_ai', input: createPlanInput,
  handler: async ({ tenant, actor, input }) => ({ status: 201, data: await createManualPlan(tenant, actor, input) }),
});
