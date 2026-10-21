/**
 * Wires cross-domain side effects exactly once per process. Imported by the
 * route wrapper and the worker so every entry point has the same behaviour.
 */
import { registerBookingHook } from './domains/booking/hooks';
import { earnCommissions, recognizeBookingRevenue, recognizeRetainedOnClose, touchCustomerVisit } from './domains/finance/postings';
import { onRefundSucceeded, refundBookingDue } from './domains/payments/service';
import { earnForBooking, reverseForRefund } from './domains/loyalty/service';
import { restoreOnRefund } from './domains/giftcards/service';
import { consumeForBooking, releaseForBooking } from './domains/memberships/service';
import { offerFreedSlot } from './domains/waitlist/service';
import { releaseSeats } from './domains/groups/service';
import { paymentTargets } from './domains/payments/targets';
import { recordServerEvent } from './domains/analytics/events';
import { consumeMaterialsForBookingItem, markOrderPaid } from './domains/commerce';

const g = globalThis as unknown as { __lumaBooted?: boolean };
if (!g.__lumaBooted) {
  g.__lumaBooted = true;
  registerBookingHook.completed(async (trx, tenantId, bookingId, actor) => {
    await recognizeBookingRevenue(trx, tenantId, bookingId, actor);
    await earnCommissions(trx, tenantId, bookingId, actor);
    await touchCustomerVisit(trx, bookingId);
    await consumeForBooking(trx, tenantId, bookingId);
    await earnForBooking(trx, tenantId, bookingId);
    // Materials are consumed once per completed booking item (idempotent per item).
    const items = await trx.selectFrom('booking_items').select('id').where('booking_id', '=', bookingId).where('superseded_at', 'is', null).execute();
    for (const it of items) await consumeMaterialsForBookingItem(trx, tenantId, it.id, actor);
  });
  // A captured order payment marks the order paid (stock reservation becomes a sale).
  // A capture on an already-cancelled order is flagged and refunded by the payments service.
  paymentTargets.order.onCaptured = async (trx, tenantId, orderId, payment) => {
    const r = await markOrderPaid(trx, tenantId, orderId, payment);
    if (r.changed) {
      const o = await trx.selectFrom('orders').select('analytics_session_id').where('id', '=', orderId).executeTakeFirstOrThrow();
      await recordServerEvent(trx, tenantId, { type: 'order_paid', entityId: orderId, sessionId: o.analytics_session_id });
    }
    return r;
  };
  // A failed attempt does not cancel the order: the customer may retry until it expires,
  // and the expiry sweep releases the reservation exactly once.
  paymentTargets.order.onFailed = async () => undefined;
  registerBookingHook.refundDue(async (trx, tenantId, bookingId, amount, basis) => {
    await refundBookingDue(trx, tenantId, bookingId, amount, basis);
  });
  registerBookingHook.released(async (trx, tenantId, bookingId, why) => {
    if (why !== 'expired') await recognizeRetainedOnClose(trx, tenantId, bookingId);
    await releaseSeats(trx, bookingId);
    await releaseForBooking(trx, bookingId);
  });
  onRefundSucceeded(async (trx, tenantId, refundId) => {
    await reverseForRefund(trx, tenantId, refundId);
    await restoreOnRefund(trx, tenantId, refundId);
  });
  registerBookingHook.slotFreed(async (trx, tenantId, bookingId) => {
    await offerFreedSlot(trx, tenantId, bookingId);
  });
}
export {};
