import { z } from 'zod';
import { route } from '@/server/http/route';
import { createService, listServices } from '@/server/domains/catalog/service';
import { serviceInput } from '@/shared/schemas/catalog';

export const GET = route({
  auth: 'tenant',
  capability: ['catalog.edit', 'bookings.view_all', 'bookings.manage', 'bookings.view_assigned'],
  input: z.object({ include_archived: z.enum(['0', '1']).optional(), category_id: z.string().uuid().optional(), q: z.string().max(100).optional() }),
  handler: async ({ tenant, input }) => ({ data: await listServices(tenant, { includeArchived: input.include_archived === '1', categoryId: input.category_id, q: input.q }) }),
});

export const POST = route({
  auth: 'tenant', capability: 'catalog.edit', input: serviceInput,
  handler: async ({ tenant, actor, input }) => ({ status: 201, data: await createService(tenant, actor, input) }),
});
