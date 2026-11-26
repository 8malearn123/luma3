import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { cancelTransfer } from '@/server/domains/commerce/transfers';
import { transferActionInput } from '@/shared/schemas/inventory';

/** Cancels a draft, or returns an in-transit transfer to its source. */
export const POST = route({
  auth: 'tenant', capability: 'inventory.transfer', feature: 'feature.inventory_transfers', input: transferActionInput, idempotency: 'optional',
  handler: async ({ tenant, actor, params }) => ({ data: await cancelTransfer(tenant, actor, requireUuidParam(params, 'id')) }),
});
