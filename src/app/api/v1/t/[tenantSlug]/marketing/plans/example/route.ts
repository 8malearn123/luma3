import { z } from 'zod';
import { route } from '@/server/http/route';
import { createExamplePlan } from '@/server/domains/marketing/plans';


/** Creates a plan clearly labelled as an EXAMPLE (never presented as analysis). */
export const POST = route({
  auth: 'tenant', capability: 'marketing.manage', feature: 'feature.marketing_ai',
  input: z.object({ kind: z.enum(['monthly', 'weekly']) }).strict(),
  handler: async ({ tenant, actor, input }) => ({ status: 201, data: await createExamplePlan(tenant, actor, input.kind) }),
});
