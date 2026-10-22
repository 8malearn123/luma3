import { z } from 'zod';
import { route } from '@/server/http/route';
import { listPriceProposals } from '@/server/domains/catalog/service';

export const GET = route({
  auth: 'tenant', capability: 'catalog.edit', input: z.object({ status: z.enum(['proposed', 'approved', 'rejected']).default('proposed') }),
  handler: async ({ tenant, input }) => ({ data: await listPriceProposals(tenant, input.status) }),
});
