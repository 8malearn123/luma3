import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { dispatchTransfer } from '@/server/domains/commerce/transfers';
import { transferActionInput } from '@/shared/schemas/inventory';

/** Executes a draft (completes it, or puts it in transit in confirm-receipt mode). Once only. */
export const POST = route({
  auth: 'tenant', capability: 'inventory.transfer', feature: 'feature.inventory_transfers', input: transferActionInput, idempotency: 'optional',
  handler: async ({ tenant, actor, params }) => ({ data: await dispatchTransfer(tenant, actor, requireUuidParam(params, 'id')) }),
});
