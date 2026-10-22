import { z } from 'zod';
import { route } from '@/server/http/route';
import { tenantSuggestions } from '@/server/domains/policy/service';

export const GET = route({
  auth: 'tenant', capability: 'incidents.review', input: z.object({ tenant_customer_id: z.string().uuid() }),
  handler: async ({ tenant, input }) => ({ data: await tenantSuggestions(tenant, input.tenant_customer_id) }),
});
