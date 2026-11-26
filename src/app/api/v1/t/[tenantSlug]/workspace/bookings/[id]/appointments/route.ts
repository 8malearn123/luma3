import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { withTenant } from '@/server/db/client';
import { Errors } from '@/server/http/errors';
import { applyHoldOutcome, createHold } from '@/server/domains/booking/service';
import { staffBookingInput } from '@/shared/schemas/booking';
import { toItem } from '@/app/api/v1/s/[slug]/availability/route';
import type { PaymentTerms } from '@/shared/payments';

/**
 * Journey 1: after booking a space, add a client appointment inside it. The
 * appointment belongs to the expert's own workspace (her client, her revenue);
 * the host salon never sees it (D14). Payment terms are hers, as for any
 * booking she creates from the dashboard: confirmed on site when her terms
 * allow it, otherwise kept as a hold for the client's online payment. The
 * appointment (with the service's buffers) must fit inside the confirmed
 * space window — otherwise 422 `outside_workspace_window`.
 */
export const POST = route({
  auth: 'tenant', capability: 'bookings.manage', feature: 'workspace.book', idempotency: 'required', input: staffBookingInput,
  handler: async ({ tenant, input, actor, params, idempotencyKey }) => {
    const r = await createHold(tenant.tenantId, {
      branchId: input.branch_id, items: input.items.map((i) => ({ ...toItem(i), staffId: i.staff_id, start: i.start })),
      customer: { kind: 'tenant_customer', tenantCustomerId: input.customer_id }, source: 'dashboard', audience: 'internal',
      customerNote: input.customer_note ?? null, internalNote: input.internal_note ?? null, idempotencyKey: idempotencyKey!, actor,
      workspaceBookingId: requireUuidParam(params, 'id'),
    });
    const body = r.body as { booking_id: string; payment_terms: PaymentTerms; requires_manual_approval: boolean };
    if (input.mode === 'confirm_on_site' && r.status === 201) {
      if (!body.payment_terms.allowed.includes('on_site')) return { status: 201, data: { ...body, confirmed: false, notice: 'prepayment_required' } };
      const out = await withTenant(tenant.tenantId, (trx) => applyHoldOutcome(trx, tenant.tenantId, body.booking_id, 'confirmed', { userId: actor.userId, source: 'dashboard', reason: 'staff_confirmed_pay_on_site' }));
      return { status: 201, data: { ...body, status: out.status, confirmed: true } };
    }
    if (r.status !== 201 && r.status !== 200) throw Errors.conflict('request_in_progress');
    return { status: r.status, data: body };
  },
});
