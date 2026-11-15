import { z } from 'zod';
import { route } from '@/server/http/route';
import { createReceipt, listReceipts } from '@/server/domains/commerce/purchasing';
import { receiptInput } from '@/shared/schemas/inventory';

export const GET = route({
  auth: 'tenant', capability: ['purchasing.view', 'purchasing.receive'], feature: 'feature.purchasing',
  input: z.object({ status: z.enum(['draft', 'posted', 'void']).optional(), not_invoiced: z.enum(['0', '1']).optional() }),
  handler: async ({ tenant, input }) => ({ data: await listReceipts(tenant, { status: input.status, not_invoiced: input.not_invoiced === '1' }) }),
});

/** Goods received into a location (RCV-…). With post: true, stock is added once; a retried key replays. */
export const POST = route({
  auth: 'tenant', capability: 'purchasing.receive', feature: 'feature.purchasing', input: receiptInput, idempotency: 'optional',
  handler: async ({ tenant, actor, input, idempotencyKey }) => ({ status: 201, data: await createReceipt(tenant, actor, input, idempotencyKey) }),
});
