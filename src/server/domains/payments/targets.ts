import type { Tx } from '../../db/client';

/**
 * What a captured/failed payment does to its target. Booking handling lives in
 * the payments service itself; orders, gift cards and memberships register
 * their handlers here (wired in src/server/boot.ts) so domains stay decoupled.
 */
type Captured = (trx: Tx, tenantId: string, targetId: string, payment: { paymentId: string; amountMinor: number }) => Promise<unknown>;
type Failed = (trx: Tx, tenantId: string, targetId: string, payment: { paymentId: string }) => Promise<unknown>;

const notWired = (what: string) => async () => { throw new Error(`payment target "${what}" is not wired`); };

export const paymentTargets: {
  order: { onCaptured: Captured; onFailed: Failed };
  giftCard: { onCaptured: Captured };
  membership: { onCaptured: Captured };
} = {
  order: { onCaptured: notWired('order'), onFailed: async () => undefined },
  giftCard: { onCaptured: notWired('gift_card') },
  membership: { onCaptured: notWired('membership') },
};
