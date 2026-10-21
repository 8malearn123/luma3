import { route, decodeCursor, encodeCursor } from '@/server/http/route';
import { applyHoldOutcome, createHold, listBookings } from '@/server/domains/booking/service';
import { withTenant } from '@/server/db/client';
import { Errors } from '@/server/http/errors';
import { listBookingsQuery, staffBookingInput } from '@/shared/schemas/booking';
import { toItem } from '@/app/api/v1/s/[slug]/availability/route';
import type { PaymentTerms } from '@/shared/payments';

export const GET = route({
  auth: 'tenant', capability: ['bookings.view_all', 'bookings.view_assigned', 'bookings.view_financial'], input: listBookingsQuery,
  handler: async ({ tenant, input }) => {
    const r = await listBookings(tenant, {
      from: input.from, to: input.to, status: input.status?.split(',').filter(Boolean), staffId: input.staff_id, branchId: input.branch_id, customerId: input.customer_id, q: input.q,
      limit: input.limit, cursor: decodeCursor<{ starts_at: string; id: string }>(input.cursor),
    });
    return { data: r.items, meta: { next_cursor: r.next_cursor ? encodeCursor(r.next_cursor) : null } };
  },
});

/**
 * POST — reception creates a booking for a customer of THIS business. Customer
 * policy decisions still apply: if the terms do not allow paying on site, the
 * booking stays held for online payment instead of being confirmed.
 */
export const POST = route({
  auth: 'tenant', capability: 'bookings.manage', idempotency: 'required', input: staffBookingInput,
  handler: async ({ tenant, input, actor, idempotencyKey }) => {
    const r = await createHold(tenant.tenantId, {
      branchId: input.branch_id, items: input.items.map((i) => ({ ...toItem(i), staffId: i.staff_id, start: i.start })),
      customer: { kind: 'tenant_customer', tenantCustomerId: input.customer_id }, source: 'dashboard', audience: 'internal',
      customerNote: input.customer_note ?? null, internalNote: input.internal_note ?? null, idempotencyKey: idempotencyKey!, actor,
    });
    const body = r.body as { booking_id: string; payment_terms: PaymentTerms; requires_manual_approval: boolean };
    if (input.mode === 'confirm_on_site' && r.status === 201) {
      if (!body.payment_terms.allowed.includes('on_site')) {
        return { status: 201, data: { ...body, confirmed: false, notice: 'prepayment_required' } };
      }
      const out = await withTenant(tenant.tenantId, (trx) => applyHoldOutcome(trx, tenant.tenantId, body.booking_id, 'confirmed', { userId: actor.userId, source: 'dashboard', reason: 'staff_confirmed_pay_on_site' }));
      return { status: 201, data: { ...body, status: out.status, confirmed: true } };
    }
    if (r.status !== 201 && r.status !== 200) throw Errors.conflict('request_in_progress');
    return { status: r.status, data: body };
  },
});
