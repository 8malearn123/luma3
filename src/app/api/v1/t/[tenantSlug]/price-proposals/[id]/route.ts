import { z } from 'zod';
import { route } from '@/server/http/route';
import { decidePriceProposal } from '@/server/domains/catalog/service';
import { requireUuidParam } from '@/server/http/params';

/** POST { decision } — owner approval; confirmed bookings keep their snapshot price. */
export const POST = route({
  auth: 'tenant', capability: 'catalog.edit', input: z.object({ decision: z.enum(['approved', 'rejected']) }),
  handler: async ({ tenant, actor, input, params }) => ({ data: await decidePriceProposal(tenant, actor, requireUuidParam(params, 'id'), input.decision) }),
});
