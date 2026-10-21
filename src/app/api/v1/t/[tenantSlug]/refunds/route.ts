import { route } from '@/server/http/route';
import { withTenant } from '@/server/db/client';
import { requestRefund } from '@/server/domains/payments/service';
import { refundInput } from '@/shared/schemas/booking';

export const GET = route({
  auth: 'tenant', capability: ['refunds.request', 'refunds.approve', 'finance.view'],
  handler: async ({ tenant }) => ({
    data: await withTenant(tenant.tenantId, (trx) => trx.selectFrom('refunds as r').innerJoin('payments as p', 'p.id', 'r.payment_id')
      .select(['r.id', 'r.amount_minor', 'r.currency', 'r.status', 'r.reason', 'r.requested_by_system', 'r.created_at', 'r.completed_at', 'p.booking_id', 'p.order_id', 'p.method'])
      .orderBy('r.created_at', 'desc').limit(200).execute()),
  }),
});

/** POST request a refund (auto-approved when the requester also holds refunds.approve). */
export const POST = route({
  auth: 'tenant', capability: 'refunds.request', idempotency: 'required', input: refundInput,
  handler: async ({ tenant, input, actor, idempotencyKey }) => ({ status: 201, data: await requestRefund(tenant, actor, { paymentId: input.payment_id, amountMinor: input.amount_minor, reason: input.reason, idempotencyKey: idempotencyKey! }) }),
});
