/**
 * Booking/order totals. Documented tax rule (configurable per business in
 * tenant_settings; no tax compliance is claimed):
 *  - prices_include_tax = true  → total = subtotal − discount; tax = round(total × r / (1 + r))
 *  - prices_include_tax = false → tax = round((subtotal − discount) × r); total = subtotal − discount + tax
 * Rounding: half-up to the nearest halala (Math.round on non-negative integers).
 */
export function computeTotals(subtotalMinor: number, discountMinor: number, taxRateBp: number, pricesIncludeTax: boolean) {
  if (subtotalMinor < 0 || discountMinor < 0) throw new Error('negative amounts');
  const discount = Math.min(discountMinor, subtotalMinor);
  const base = subtotalMinor - discount;
  if (pricesIncludeTax) {
    const tax = taxRateBp ? Math.round((base * taxRateBp) / (10000 + taxRateBp)) : 0;
    return { subtotal: subtotalMinor, discount, tax, total: base };
  }
  const tax = Math.round((base * taxRateBp) / 10000);
  return { subtotal: subtotalMinor, discount, tax, total: base + tax };
}

/**
 * Refund due on cancellation, from the policy snapshot captured at booking time
 * (never the current settings). Business-initiated cancellations refund in full.
 */
export function cancellationRefund(opts: {
  paidMinor: number; totalMinor: number; startsAt: Date; now: Date; source: 'customer' | 'business' | 'system';
  freeCancellationHours: number; lateFeeBp: number;
}) {
  if (opts.paidMinor <= 0) return { refundMinor: 0, feeMinor: 0, basis: 'nothing_paid' as const };
  if (opts.source !== 'customer') return { refundMinor: opts.paidMinor, feeMinor: 0, basis: 'business_cancelled' as const };
  const hoursBefore = (opts.startsAt.getTime() - opts.now.getTime()) / 3_600_000;
  if (hoursBefore >= opts.freeCancellationHours) return { refundMinor: opts.paidMinor, feeMinor: 0, basis: 'free_window' as const };
  const fee = Math.min(opts.paidMinor, Math.round((opts.totalMinor * opts.lateFeeBp) / 10000));
  return { refundMinor: opts.paidMinor - fee, feeMinor: fee, basis: 'late_cancellation' as const };
}
