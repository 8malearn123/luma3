import { route } from '@/server/http/route';
import { createPayment, listPayments } from '@/server/domains/commerce/purchasing';
import { paymentInput } from '@/shared/schemas/inventory';

export const GET = route({
  auth: 'tenant', capability: ['purchasing.view', 'purchasing.pay'], feature: 'feature.purchasing',
  handler: async ({ tenant }) => ({ data: await listPayments(tenant) }),
});

/** Supplier payment (Dr accounts payable / Cr cash or bank). Idempotency-Key required. */
export const POST = route({
  auth: 'tenant', capability: 'purchasing.pay', feature: 'feature.purchasing', input: paymentInput, idempotency: 'required',
  handler: async ({ tenant, actor, input, idempotencyKey }) => ({ status: 201, data: await createPayment(tenant, actor, input, idempotencyKey) }),
});
