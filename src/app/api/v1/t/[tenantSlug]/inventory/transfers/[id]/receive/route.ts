import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { receiveTransfer } from '@/server/domains/commerce/transfers';
import { transferActionInput } from '@/shared/schemas/inventory';

/** Destination confirms receipt of a transfer in transit. */
export const POST = route({
  auth: 'tenant', capability: 'inventory.transfer', feature: 'feature.inventory_transfers', input: transferActionInput, idempotency: 'optional',
  handler: async ({ tenant, actor, params }) => ({ data: await receiveTransfer(tenant, actor, requireUuidParam(params, 'id')) }),
});
