import { route } from '@/server/http/route';
import { consumeForBookingItem } from '@/server/domains/commerce/inventory';
import { consumeInput } from '@/shared/schemas/commerce';

/** Manual trigger of recipe consumption for a completed visit (exactly once; normally called by booking completion). */
export const POST = route({
  auth: 'tenant', capability: 'inventory.manage', feature: 'feature.inventory', input: consumeInput,
  handler: async ({ tenant, actor, input }) => ({ data: await consumeForBookingItem(tenant, actor, input.booking_item_id) }),
});
