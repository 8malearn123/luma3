import type { TransactionStatus } from '../../contracts/canonical';

/**
 * LUMA → canonical status mapping (§5.2). Kept as data so it is also written
 * to source_mappings.status_map and shown to reviewers.
 */
export const LUMA_STATUS_MAP = {
  booking: {
    draft: 'requested', held: 'requested', pending_approval: 'requested', pending_payment: 'requested',
    confirmed: 'confirmed', checked_in: 'confirmed', in_service: 'confirmed',
    completed: 'fulfilled', expired: 'expired', no_show: 'no_show',
    // cancel_source 'customer' → cancelled_customer; 'business' | 'system' | unknown → cancelled_business
    cancelled: 'cancelled_customer|cancelled_business',
  },
  order: {
    draft: 'requested', pending_payment: 'requested',
    // A paid order is a sale (revenue recognised at payment).
    paid: 'fulfilled', preparing: 'fulfilled', ready: 'fulfilled', collected: 'fulfilled',
    cancelled: 'cancelled_customer|cancelled_business',
  },
} as const;

export const LUMA_REVENUE_BASIS = 'net = total_minor − tax_minor − refunded_minor (after discounts, before tax, after refunds); lines share the net pro rata to line_total_minor';

export function normalizeStatus(kind: 'booking' | 'order', sourceStatus: string, cancelSource: string | null): TransactionStatus {
  const map = LUMA_STATUS_MAP[kind] as Record<string, string>;
  const m = map[sourceStatus];
  if (!m) return 'requested';
  if (m.includes('|')) return cancelSource === 'customer' ? 'cancelled_customer' : 'cancelled_business';
  return m as TransactionStatus;
}

export function netOf(t: { total_minor: number; tax_minor: number; refunded_minor: number }) {
  return Math.max(0, t.total_minor - t.tax_minor - t.refunded_minor);
}

/** Splits `net` across lines pro rata to their totals; the remainder goes to the last line so the sum is exact. */
export function splitNet(net: number, lineTotals: number[]): number[] {
  const total = lineTotals.reduce((a, b) => a + b, 0);
  if (!lineTotals.length) return [];
  if (total <= 0) return lineTotals.map((_, i) => (i === lineTotals.length - 1 ? net : 0));
  const out = lineTotals.map((x) => Math.floor((net * x) / total));
  out[out.length - 1]! += net - out.reduce((a, b) => a + b, 0);
  return out;
}

/** §5.4 consistency: lines add up to the pre-discount subtotal (±1%), refunds never exceed the total. */
export function isConsistent(t: { subtotal_minor: number; total_minor: number; refunded_minor: number; status: TransactionStatus }, lineTotals: number[]) {
  if (t.refunded_minor > t.total_minor) return false;
  if (t.status === 'fulfilled' && !lineTotals.length) return false;
  if (!lineTotals.length) return true;
  const s = lineTotals.reduce((a, b) => a + b, 0);
  return Math.abs(s - t.subtotal_minor) <= Math.max(1, Math.round(t.subtotal_minor * 0.01));
}

export function freshnessOf(published: number | null, now: number): 'fresh' | 'aging' | 'stale' | 'unknown' {
  if (published === null) return 'unknown';
  const days = (now - published) / 86_400_000;
  return days <= 14 ? 'fresh' : days <= 45 ? 'aging' : 'stale';
}
