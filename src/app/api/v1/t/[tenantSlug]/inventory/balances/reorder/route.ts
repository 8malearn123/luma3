import { z } from 'zod';
import { route } from '@/server/http/route';
import { setReorderLevel } from '@/server/domains/commerce/locations';

/** Per-location reorder level (a reorder task opens when available stock falls to it). */
export const PUT = route({
  auth: 'tenant', capability: 'inventory.manage', feature: 'feature.inventory',
  input: z.object({ inventory_item_id: z.string().uuid(), location_id: z.string().uuid(), reorder_level: z.number().min(0).max(10_000_000).nullable() }).strict(),
  handler: async ({ tenant, actor, input }) => ({ data: await setReorderLevel(tenant, actor, input.inventory_item_id, input.location_id, input.reorder_level) }),
});
