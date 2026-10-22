import type { Tx } from '../../db/client';
import type { AuditActor } from '../../infra/audit';

/**
 * Side effects of booking transitions, executed inside the transition's
 * transaction. Other domains register handlers (finance postings, commissions,
 * material consumption, loyalty, waitlist offers, refunds). Each handler must
 * be exactly-once by its own constraints because a transition can be retried.
 */
type Completed = (trx: Tx, tenantId: string, bookingId: string, actorUserId: string | null) => Promise<void>;
type Released = (trx: Tx, tenantId: string, bookingId: string, why: 'expired' | 'cancelled' | 'no_show') => Promise<void>;
type RefundDue = (trx: Tx, tenantId: string, bookingId: string, amountMinor: number, basis: string, actor: AuditActor) => Promise<void>;
type SlotFreed = (trx: Tx, tenantId: string, bookingId: string) => Promise<void>;

const completed: Completed[] = [];
const released: Released[] = [];
const refundDue: RefundDue[] = [];
const slotFreed: SlotFreed[] = [];

export const bookingHooks = {
  onCompleted: async (...a: Parameters<Completed>) => { for (const h of completed) await h(...a); },
  onReleased: async (...a: Parameters<Released>) => { for (const h of released) await h(...a); },
  onRefundDue: async (...a: Parameters<RefundDue>) => { for (const h of refundDue) await h(...a); },
  onSlotFreed: async (...a: Parameters<SlotFreed>) => { for (const h of slotFreed) await h(...a); },
};

export const registerBookingHook = {
  completed: (h: Completed) => { completed.push(h); },
  released: (h: Released) => { released.push(h); },
  refundDue: (h: RefundDue) => { refundDue.push(h); },
  slotFreed: (h: SlotFreed) => { slotFreed.push(h); },
};
