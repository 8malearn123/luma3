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

const g = globalThis as unknown as { __lumaBooted?: boolean };
if (!g.__lumaBooted) {
  g.__lumaBooted = true;
  registerBookingHook.completed(async (trx, tenantId, bookingId, actor) => {
    await recognizeBookingRevenue(trx, tenantId, bookingId, actor);
    await earnCommissions(trx, tenantId, bookingId, actor);
    await touchCustomerVisit(trx, bookingId);
    await consumeForBooking(trx, tenantId, bookingId);
    await earnForBooking(trx, tenantId, bookingId);
  });
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
