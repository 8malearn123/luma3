import { z } from 'zod';
import { route } from '@/server/http/route';
import { reorder } from '@/server/domains/catalog/service';
import { requireCapability } from '@/server/tenancy/access';

/** POST { entity, ids } — keyboard/touch-friendly reordering (no drag required). */
export const POST = route({
  auth: 'tenant',
  input: z.object({ entity: z.enum(['categories', 'services', 'products', 'staff']), ids: z.array(z.string().uuid()).min(1).max(500) }),
  handler: async ({ tenant, input }) => {
    requireCapability(tenant, input.entity === 'staff' ? 'staff.edit' : 'catalog.edit');
    const table = input.entity === 'staff' ? 'staff_profiles' : input.entity;
    return { data: await reorder(tenant, table, input.ids) };
  },
});
