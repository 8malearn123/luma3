import { sql } from 'kysely';
import type { Tx } from '../../db/client';
import { alreadyPosted, post, splitTax } from './journal';

/**
 * Revenue recognition at service completion (exactly once per booking):
 * prepaid amounts move from customer deposits to revenue; any unpaid part
 * becomes a receivable. Service completion does not imply full payment.
 */
export async function recognizeBookingRevenue(trx: Tx, tenantId: string, bookingId: string, actorUserId: string | null) {
  if (await alreadyPosted(trx, tenantId, 'booking_completion', bookingId)) return;
  const b = await trx.selectFrom('bookings').selectAll().where('id', '=', bookingId).executeTakeFirstOrThrow();
  const prepaid = Math.min(Math.max(0, b.paid_minor - b.refunded_minor), b.total_minor);
  const receivable = b.total_minor - prepaid;
  const { net, tax } = splitTax(b.total_minor, b.tax_minor, b.total_minor);
  await post(trx, tenantId, { type: 'booking_completion', id: bookingId }, [
    { account: 'customer_deposits', debit: prepaid },
    { account: 'accounts_receivable', debit: receivable },
    { account: 'service_revenue', credit: net },
    { account: 'tax_payable', credit: tax },
  ], { createdBy: actorUserId, memo: `service completed ${b.number}` });
}

/**
 * When a booking closes without service (cancelled / no-show), money kept under
 * the booking-time policy (late-cancellation fee, retained deposit) is
 * recognised as service revenue; everything else is refunded separately.
 */
export async function recognizeRetainedOnClose(trx: Tx, tenantId: string, bookingId: string) {
  if (await alreadyPosted(trx, tenantId, 'booking_retained', bookingId)) return;
  const b = await trx.selectFrom('bookings').select(['paid_minor', 'refunded_minor', 'number']).where('id', '=', bookingId).executeTakeFirstOrThrow();
  const pending = await trx.selectFrom('refunds as r').innerJoin('payments as p', 'p.id', 'r.payment_id')
    .select(sql<number>`coalesce(sum(r.amount_minor), 0)::bigint`.as('n')).where('p.booking_id', '=', bookingId).where('r.status', 'in', ['requested', 'pending']).executeTakeFirstOrThrow();
  const retained = b.paid_minor - b.refunded_minor - pending.n;
  if (retained <= 0) return;
  await post(trx, tenantId, { type: 'booking_retained', id: bookingId }, [
    { account: 'customer_deposits', debit: retained }, { account: 'service_revenue', credit: retained },
  ], { memo: `retained per booking policy ${b.number}` });
}

/*
 * Commission is no longer earned per booking. It is computed monthly in
 * payroll (domains/payroll/service.ts) from service and product sales, with the
 * business's per-category rate and tiers, and posted when the month closes.
 */

export async function touchCustomerVisit(trx: Tx, bookingId: string) {
  const b = await trx.selectFrom('bookings').select(['tenant_customer_id', 'starts_at']).where('id', '=', bookingId).executeTakeFirstOrThrow();
  await trx.updateTable('tenant_customers').set({
    last_visit_at: sql`greatest(coalesce(last_visit_at, ${b.starts_at}), ${b.starts_at})`,
    first_visit_at: sql`least(coalesce(first_visit_at, ${b.starts_at}), ${b.starts_at})`,
  }).where('id', '=', b.tenant_customer_id).execute();
}
