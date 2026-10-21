import { z } from 'zod';
import { route } from '@/server/http/route';
import { adjustPoints } from '@/server/domains/loyalty/service';

/** Manual ledger adjustment (never an edited balance), with a mandatory reason. */
export const POST = route({
  auth: 'tenant', capability: 'loyalty.manage', feature: 'feature.loyalty',
  input: z.object({ customer_id: z.string().uuid(), delta: z.number().int().min(-100000).max(100000).refine((v) => v !== 0), reason: z.string().trim().min(3).max(300) }),
  handler: async ({ tenant, actor, input }) => ({ data: await adjustPoints(tenant, actor, input.customer_id, input.delta, input.reason) }),
});
