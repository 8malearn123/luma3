import { z } from 'zod';
import { route } from '@/server/http/route';
import { createCategory, listCategories } from '@/server/domains/catalog/service';
import { categoryInput } from '@/shared/schemas/catalog';

export const GET = route({
  auth: 'tenant',
  capability: ['catalog.edit', 'bookings.view_all', 'bookings.view_assigned', 'orders.view'],
  input: z.object({ kind: z.enum(['service', 'product']).optional(), include_archived: z.enum(['0', '1']).optional() }),
  handler: async ({ tenant, input }) => ({ data: await listCategories(tenant, input.kind, input.include_archived === '1') }),
});

export const POST = route({
  auth: 'tenant', capability: 'catalog.edit', input: categoryInput,
  handler: async ({ tenant, actor, input }) => ({ status: 201, data: await createCategory(tenant, actor, input) }),
});
