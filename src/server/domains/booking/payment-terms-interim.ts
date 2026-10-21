import type { Tx } from '../../db/client';
import type { PaymentMethod, PaymentOption, PaymentTerms } from '@/shared/payments';

const ONLINE: PaymentMethod[] = ['card', 'mada', 'apple_pay', 'tabby', 'tamara', 'sandbox'];

/**
 * INTERIM implementation of the payment-terms contract (business policy only).
 * Customer policy decisions are applied by the policy domain's implementation,
 * which replaces this module via ./terms.ts.
 */
export async function computePaymentTerms(trx: Tx, input: {
  tenantId: string; tenantCustomerId: string | null; customerUserId: string | null; amountDueMinor: number;
  availableMethods: PaymentMethod[]; context: 'booking' | 'order'; now?: Date;
}): Promise<PaymentTerms> {
  const now = input.now ?? new Date();
  const s = await trx.selectFrom('tenant_settings').selectAll().where('tenant_id', '=', input.tenantId).executeTakeFirstOrThrow();
  const online = input.availableMethods.some((m) => ONLINE.includes(m));
  const allowed: PaymentOption[] = [];
  let depositMinor: number | null = null;
  if (input.amountDueMinor === 0) {
    return { allowed: ['on_site'], depositMinor: null, amountDueMinor: 0, requiresManualApproval: false, blocked: false, reasonCodes: ['free'], decisionIds: [], customerExplanation: null, policySnapshot: {}, computedAt: now.toISOString(), validUntil: new Date(now.getTime() + s.hold_ttl_sec * 1000).toISOString() };
  }
  if (online && s.allow_full_prepay) allowed.push('full');
  if (online && s.deposit_mode !== 'none') {
    const raw = s.deposit_mode === 'percent' ? Math.round((input.amountDueMinor * s.deposit_percent_bp) / 10000) : s.deposit_fixed_minor;
    const dep = Math.min(raw, input.amountDueMinor);
    if (dep > 0 && dep < input.amountDueMinor) { allowed.push('deposit'); depositMinor = dep; }
  }
  if (s.allow_pay_on_site && input.context === 'booking' && s.deposit_mode === 'none') allowed.push('on_site');
  return {
    allowed, depositMinor, amountDueMinor: input.amountDueMinor, requiresManualApproval: false, blocked: allowed.length === 0,
    reasonCodes: allowed.length ? ['business_policy'] : ['no_compatible_method'], decisionIds: [],
    customerExplanation: null,
    policySnapshot: { deposit_mode: s.deposit_mode, deposit_percent_bp: s.deposit_percent_bp, deposit_fixed_minor: s.deposit_fixed_minor, allow_pay_on_site: s.allow_pay_on_site, allow_full_prepay: s.allow_full_prepay },
    computedAt: now.toISOString(), validUntil: new Date(now.getTime() + s.hold_ttl_sec * 1000).toISOString(),
  };
}
