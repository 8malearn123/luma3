import { z } from 'zod';
import { route } from '@/server/http/route';
import { createTransfer, listTransfers } from '@/server/domains/commerce/transfers';
import { transferInput } from '@/shared/schemas/inventory';

export const GET = route({
  auth: 'tenant', capability: ['inventory.view', 'inventory.manage', 'inventory.transfer'], feature: 'feature.inventory_transfers',
  input: z.object({ status: z.enum(['draft', 'in_transit', 'completed', 'cancelled']).optional() }),
  handler: async ({ tenant, input }) => ({ data: await listTransfers(tenant, input) }),
});

/** Creates (and by default executes) a transfer. The Idempotency-Key makes a retried request a replay. */
export const POST = route({
  auth: 'tenant', capability: 'inventory.transfer', feature: 'feature.inventory_transfers', input: transferInput, idempotency: 'required',
  handler: async ({ tenant, actor, input, idempotencyKey }) => ({ status: 201, data: await createTransfer(tenant, actor, input, idempotencyKey) }),
});
