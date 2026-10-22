import { sql } from 'kysely';
import { db, withTenant } from '../../db/client';
import { Errors } from '../../http/errors';
import { getInvoice } from '../finance/service';
import { cancellationRefund } from './pricing';
import { TRANSITIONS, type BookingStatus } from './transitions';

/** Resolves the tenant of a booking that belongs to this customer, or 404. */
export async function customerBookingTenant(userId: string, bookingId: string) {
  const r = await sql<{ tenant_id: string; tenant_slug: string }>`select * from app.customer_booking_ref(${userId}, ${bookingId})`.execute(db());
  const row = r.rows[0];
  if (!row) throw Errors.notFound('booking');
  return row;
}

type PolicySnap = {
  free_cancellation_hours?: number; late_cancellation_fee_bp?: number; no_show_grace_min?: number; tax_label?: string | null; tax_rate_bp?: number;
  prices_include_tax?: boolean; booking_policy_text_ar?: string | null; booking_policy_text_en?: string | null; captured_at?: string;
};

/**
 * The customer's own booking as she may see it: the business, the snapshot of
 * items/prices/terms captured at booking time, her payments and receipts, and
 * what she can still do (with the refund the snapshot terms would give if she
 * cancelled now — the same function the cancellation itself uses).
 */
export async function customerBookingDetail(userId: string, bookingId: string, now = new Date()) {
  const ref = await customerBookingTenant(userId, bookingId);
  return withTenant(ref.tenant_id, async (trx) => {
    const b = await trx.selectFrom('bookings').selectAll().where('id', '=', bookingId).executeTakeFirst();
    if (!b || b.customer_user_id !== userId) throw Errors.notFound('booking');
    const [tenant, items, payments, receipts, group] = await Promise.all([
      trx.selectFrom('tenants').select(['name', 'slug']).where('id', '=', ref.tenant_id).executeTakeFirstOrThrow(),
      trx.selectFrom('booking_items').select(['id', 'service_id', 'variant_id', 'staff_id', 'service_name_ar', 'service_name_en', 'staff_name', 'starts_at', 'ends_at', 'duration_min', 'line_total_minor', 'addons'])
        .where('booking_id', '=', bookingId).where('superseded_at', 'is', null).orderBy('sequence').execute(),
      trx.selectFrom('payments').select(['id', 'kind', 'method', 'amount_minor', 'currency', 'status', 'captured_at', 'created_at']).where('booking_id', '=', bookingId).orderBy('created_at').execute(),
      trx.selectFrom('invoices').select(['id', 'number', 'kind', 'total_minor', 'currency', 'issued_at']).where('booking_id', '=', bookingId).orderBy('issued_at').execute(),
      trx.selectFrom('group_session_bookings').select(['group_session_id', 'seats']).where('booking_id', '=', bookingId).executeTakeFirst(),
    ]);
    const policy = (b.policy_snapshot ?? {}) as PolicySnap;
    const status = b.status as BookingStatus;
    const before = now < b.starts_at;
    const canCancel = before && TRANSITIONS.cancel.from.includes(status);
    const canReschedule = before && !group && ['confirmed', 'pending_approval'].includes(status);
    const preview = canCancel ? cancellationRefund({
      paidMinor: b.paid_minor - b.refunded_minor, totalMinor: b.total_minor, startsAt: b.starts_at, now, source: 'customer',
      freeCancellationHours: policy.free_cancellation_hours ?? 24, lateFeeBp: policy.late_cancellation_fee_bp ?? 0,
    }) : null;
    const holdPending = ['held', 'pending_payment'].includes(status) && (!b.hold_expires_at || b.hold_expires_at > now);
    return {
      id: b.id, number: b.number, status: b.status, payment_status: b.payment_status, starts_at: b.starts_at, ends_at: b.ends_at, timezone: b.timezone, branch_id: b.branch_id,
      subtotal_minor: b.subtotal_minor, discount_minor: b.discount_minor, tax_minor: b.tax_minor, total_minor: b.total_minor, deposit_due_minor: b.deposit_due_minor,
      paid_minor: b.paid_minor, refunded_minor: b.refunded_minor, currency: b.currency, hold_expires_at: b.hold_expires_at, customer_note: b.customer_note,
      cancelled_at: b.cancelled_at, cancel_source: b.cancel_source,
      tenant: { name: tenant.name, slug: tenant.slug },
      items: items.map((i) => ({ ...i, addon_ids: ((i.addons as Array<{ id?: string }> | null) ?? []).map((a) => a.id).filter((x): x is string => !!x), addons: undefined })),
      terms: {
        free_cancellation_hours: policy.free_cancellation_hours ?? null, late_cancellation_fee_bp: policy.late_cancellation_fee_bp ?? null,
        policy_text_ar: policy.booking_policy_text_ar ?? null, policy_text_en: policy.booking_policy_text_en ?? null, tax_label: policy.tax_label ?? null, captured_at: policy.captured_at ?? null,
      },
      payments, receipts,
      group_session: group ? { id: group.group_session_id, seats: group.seats } : null,
      actions: {
        can_cancel: canCancel, can_reschedule: canReschedule,
        cancellation_preview: preview ? { refund_minor: preview.refundMinor, fee_minor: preview.feeMinor, basis: preview.basis } : null,
        checkout_path: holdPending ? `/s/${tenant.slug}/checkout/booking/${b.id}` : null,
      },
    };
  });
}

/** One of the customer's own receipts/invoices for this booking. */
export async function customerReceipt(userId: string, bookingId: string, invoiceId: string) {
  const ref = await customerBookingTenant(userId, bookingId);
  const inv = await getInvoice(ref.tenant_id, invoiceId);
  if (inv.booking_id !== bookingId) throw Errors.notFound('invoice');
  return inv;
}
