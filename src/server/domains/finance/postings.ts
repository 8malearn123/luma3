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

/**
 * Commissions earned at completion, from configurable rules with explicit
 * precedence: staff+service > staff > service > business default. The rule is
 * snapshotted on the entry; refunds create explicit reversal entries.
 */
export async function earnCommissions(trx: Tx, tenantId: string, bookingId: string, actorUserId: string | null) {
  const b = await trx.selectFrom('bookings').select(['total_minor', 'subtotal_minor', 'tax_minor', 'discount_minor', 'starts_at']).where('id', '=', bookingId).executeTakeFirstOrThrow();
  const items = await trx.selectFrom('booking_items').selectAll().where('booking_id', '=', bookingId).where('superseded_at', 'is', null).execute();
  const day = b.starts_at.toISOString().slice(0, 10);
  const rules = await trx.selectFrom('commission_rules').selectAll().where('is_active', '=', true).where('effective_from', '<=', day)
    .where((eb) => eb.or([eb('effective_to', 'is', null), eb('effective_to', '>=', day)])).execute();
  for (const it of items) {
    const score = (r: (typeof rules)[number]) =>
      (r.staff_id === it.staff_id && r.service_id === it.service_id ? 4 : 0) || (r.staff_id === it.staff_id && !r.service_id ? 3 : 0)
      || (!r.staff_id && r.service_id === it.service_id ? 2 : 0) || (!r.staff_id && !r.service_id ? 1 : 0);
    const rule = rules.filter((r) => score(r) > 0).sort((x, y) => score(y) - score(x))[0];
    if (!rule) continue;
    // Commission base: the line's share of the net (after discount, excluding tax).
    const share = b.subtotal_minor > 0 ? it.line_total_minor / b.subtotal_minor : 0;
    const base = Math.round((b.total_minor - b.tax_minor) * share);
    const amount = rule.kind === 'percent' ? Math.round((base * (rule.rate_bp ?? 0)) / 10000) : (rule.amount_minor ?? 0);
    if (amount <= 0) continue;
    const ins = await trx.insertInto('commission_entries').values({
      tenant_id: tenantId, staff_id: it.staff_id, booking_item_id: it.id, kind: 'earned', base_minor: base, amount_minor: amount,
      rule_snapshot: JSON.stringify({ id: rule.id, kind: rule.kind, rate_bp: rule.rate_bp, amount_minor: rule.amount_minor, staff_id: rule.staff_id, service_id: rule.service_id }),
      created_by: actorUserId,
    }).onConflict((oc) => oc.column('booking_item_id').where('kind', '=', 'earned').doNothing()).returning('id').executeTakeFirst();
    if (ins) {
      await post(trx, tenantId, { type: 'commission', id: ins.id }, [{ account: 'commissions_expense', debit: amount }, { account: 'commissions_payable', credit: amount }], { createdBy: actorUserId });
    }
  }
}

export async function touchCustomerVisit(trx: Tx, bookingId: string) {
  const b = await trx.selectFrom('bookings').select(['tenant_customer_id', 'starts_at']).where('id', '=', bookingId).executeTakeFirstOrThrow();
  await trx.updateTable('tenant_customers').set({
    last_visit_at: sql`greatest(coalesce(last_visit_at, ${b.starts_at}), ${b.starts_at})`,
    first_visit_at: sql`least(coalesce(first_visit_at, ${b.starts_at}), ${b.starts_at})`,
  }).where('id', '=', b.tenant_customer_id).execute();
}
