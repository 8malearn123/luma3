import { z } from 'zod';
import { route } from '@/server/http/route';
import { createResource, listResources } from '@/server/domains/catalog/service';

export const GET = route({ auth: 'tenant', capability: ['catalog.edit', 'schedule.manage', 'bookings.manage'], handler: async ({ tenant }) => ({ data: await listResources(tenant) }) });
export const POST = route({
  auth: 'tenant', capability: 'catalog.edit', feature: 'feature.resources',
  input: z.object({ branch_id: z.string().uuid(), resource_type_id: z.string().uuid(), name: z.string().trim().min(1).max(80) }),
  handler: async ({ tenant, actor, input }) => ({ status: 201, data: await createResource(tenant, actor, input) }),
});
