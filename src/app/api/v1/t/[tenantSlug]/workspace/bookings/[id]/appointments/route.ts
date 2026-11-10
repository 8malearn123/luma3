import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { createHold } from '@/server/domains/booking/service';
import { staffBookingInput } from '@/shared/schemas/booking';
import { toItem } from '@/app/api/v1/s/[slug]/availability/route';

/**
 * Journey 1: after booking a space, add a client appointment inside it. The
 * appointment belongs to the expert's own workspace (her client, her revenue);
 * the host salon never sees it (D14). Payment terms are hers, as for any booking.
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
    return { status: r.status, data: r.body };
  },
});
