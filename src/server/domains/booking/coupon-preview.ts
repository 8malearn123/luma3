import { withTenant } from '../../db/client';
import { validateCoupon } from '../commerce/coupons';
import { policySnapshot } from './service';
import { primaryBranch, resolveItems, type RequestedItem } from './loader';
import { computePaymentTerms } from './terms';
import { enabledMethods } from './service';
import { computeTotals } from './pricing';

const NO_CUSTOMER = '00000000-0000-0000-0000-000000000000';

/**
 * Booking-page coupon preview. The server prices the itinerary the customer
 * chose (service × specialist), validates the coupon scope (services / all),
 * and shows the discount, the new total and the deposit computed AFTER the
 * discount. Nothing is redeemed: the hold re-validates and redeems atomically.
 */
export async function previewBookingCoupon(tenantId: string, input: { branchId?: string | null; code: string; items: Array<RequestedItem & { staffId: string }>; userId: string | null }) {
  return withTenant(tenantId, async (trx) => {
    const branchId = input.branchId ?? (await primaryBranch(trx, tenantId)).id;
    const resolved = await resolveItems(trx, tenantId, branchId, input.items, 'public');
    const subtotal = resolved.reduce((a, r) => {
      const staffId = input.items.find((i) => i.key === r.key)!.staffId;
      const t = r.staffTerms[staffId] ?? Object.values(r.staffTerms)[0]!;
      return a + t.priceMinor;
    }, 0);
    const tc = input.userId ? await trx.selectFrom('tenant_customers').select(['id', 'user_id']).where('tenant_id', '=', tenantId).where('user_id', '=', input.userId).executeTakeFirst() : undefined;
    const c = await validateCoupon(trx, tenantId, input.code, { tenantCustomerId: tc?.id ?? NO_CUSTOMER, subtotalMinor: subtotal, appliesTo: 'services' });
    const policy = await policySnapshot(trx, tenantId);
    const totals = computeTotals(subtotal, c.discountMinor, policy.tax_rate_bp, policy.prices_include_tax);
    const terms = await computePaymentTerms(trx, {
      tenantId, tenantCustomerId: tc?.id ?? null, customerUserId: tc?.user_id ?? null, amountDueMinor: totals.total, availableMethods: await enabledMethods(trx, tenantId), context: 'booking',
    });
    return { code: input.code.trim().toUpperCase(), subtotal_minor: totals.subtotal, discount_minor: totals.discount, tax_minor: totals.tax, total_minor: totals.total, deposit_minor: terms.depositMinor ?? 0 };
  });
}
