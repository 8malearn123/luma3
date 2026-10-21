import { sql } from 'kysely';
import type { Tx } from '../../db/client';
import { Errors } from '../../http/errors';
import type { PaymentMethod, PaymentOption, PaymentTerms } from '@/shared/payments';
import type { PolicyAction } from '@/shared/schemas/policy';
import { genericExplanation } from './explanations';

/**
 * Payment-terms algorithm (spec §20).
 *
 * 1. Methods the business can actually take right now (`availableMethods`, from
 *    the payments domain): on-site needs cash or a POS terminal *and*
 *    tenant_settings.allow_pay_on_site; online options (full / deposit) need at
 *    least one online method.
 * 2. Business policy snapshot from tenant_settings (deposit mode/percent/fixed,
 *    allow_full_prepay, allow_pay_on_site, hold TTL) + the customer's ACTIVE
 *    decisions in tenant scope (this business) and platform scope (actions only,
 *    via app.platform_decisions_for_customer). Expired, superseded and revoked
 *    decisions are ignored (status + effective/expiry window).
 * 3. Priority (documented, explicit):
 *        suspend_account (platform only)  → blocks payment entirely
 *        require_full_payment             → rank 2
 *        require_deposit                  → rank 1
 *        default                          → rank 0
 *        manual_approval                  → additive flag, combines with any rank
 *    The strictest active restriction across BOTH scopes wins; a tenant
 *    "default" decision never cancels a platform restriction. Corrections are
 *    modelled as supersession (the old decision becomes `superseded`).
 * 4. require_full_payment removes deposit and on-site. require_deposit removes
 *    on-site; if the business has no deposit configured (or the deposit would
 *    equal the total) the restriction is *strengthened* to full prepayment,
 *    never weakened. A business deposit policy also removes pay-on-site.
 * 5. No compatible option → blocked=true with a contact / manual-approval path.
 *    The browser can never re-enable an option: checkout must call
 *    requireAllowedOption() against the server-computed terms.
 * 6. Internal reason codes + decision ids are recorded; the customer receives a
 *    bilingual explanation (decision text or a generic one) and the appeal path.
 * 7. Terms are valid until computedAt + tenant hold TTL. reassessPaymentTerms()
 *    recomputes and reports whether material terms changed, so checkout can ask
 *    the customer to re-confirm before creating a payment.
 *
 * Deposits: percentage (basis points) or fixed amount in integer halalas,
 * rounded half-up, capped at the amount due. A deposit of 0 means "no deposit";
 * a deposit equal to the amount due collapses into full prepayment.
 * Orders (context 'order') never take deposits.
 */

export const TERMS_ALGORITHM_VERSION = 1;
export const APPEAL_PATH = '/account/policy';

const ONSITE_METHODS: ReadonlySet<PaymentMethod> = new Set(['cash', 'pos_terminal']);
const ACTION_RANK: Record<PolicyAction, number> = {
  default: 0, manual_approval: 0, require_deposit: 1, require_full_payment: 2, suspend_account: 3,
};

export type PaymentTermsInput = {
  tenantId: string;
  tenantCustomerId: string | null;
  customerUserId: string | null;
  amountDueMinor: number;
  availableMethods: PaymentMethod[];
  context: 'booking' | 'order';
  now?: Date;
};

export type ActiveDecision = {
  id: string;
  scope: 'tenant' | 'platform';
  action: PolicyAction;
  explanation_ar: string | null;
  explanation_en: string | null;
};

/** Round-half-up percentage of an integer amount (basis points), capped at the amount. */
export function depositFor(amountMinor: number, settings: { deposit_mode: string; deposit_percent_bp: number; deposit_fixed_minor: number }): number {
  if (amountMinor <= 0) return 0;
  let d = 0;
  if (settings.deposit_mode === 'percent') d = Math.floor((amountMinor * settings.deposit_percent_bp + 5000) / 10000);
  else if (settings.deposit_mode === 'fixed') d = settings.deposit_fixed_minor;
  return Math.max(0, Math.min(d, amountMinor));
}

/**
 * Active decisions that apply to one customer at one business, in the caller's
 * withTenant transaction. Platform decisions come from a definer function that
 * exposes only the action and the customer-facing explanation.
 */
export async function activeDecisionsFor(trx: Tx, tenantId: string, tenantCustomerId: string | null, customerUserId: string | null, now = new Date()): Promise<ActiveDecision[]> {
  const out: ActiveDecision[] = [];
  if (tenantCustomerId || customerUserId) {
    let q = trx.selectFrom('policy_decisions')
      .select(['id', 'action', 'customer_explanation_ar', 'customer_explanation_en'])
      .where('tenant_id', '=', tenantId).where('scope', '=', 'tenant').where('status', '=', 'active')
      .where('effective_at', '<=', now)
      .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', now)]));
    q = q.where((eb) => {
      const ors = [];
      if (tenantCustomerId) ors.push(eb('tenant_customer_id', '=', tenantCustomerId));
      if (customerUserId) ors.push(eb('customer_user_id', '=', customerUserId));
      return eb.or(ors);
    });
    for (const r of await q.execute()) {
      out.push({ id: r.id, scope: 'tenant', action: r.action as PolicyAction, explanation_ar: r.customer_explanation_ar, explanation_en: r.customer_explanation_en });
    }
  }
  if (customerUserId) {
    const p = await sql<{ id: string; action: string; effective_at: Date; expires_at: Date | null; customer_explanation_ar: string | null; customer_explanation_en: string | null }>`
      select * from app.platform_decisions_for_customer(${customerUserId})`.execute(trx);
    for (const r of p.rows) {
      if (r.effective_at > now || (r.expires_at && r.expires_at <= now)) continue;
      out.push({ id: r.id, scope: 'platform', action: r.action as PolicyAction, explanation_ar: r.customer_explanation_ar, explanation_en: r.customer_explanation_en });
    }
  }
  return out;
}

/** Strictest action across decisions + the manual-approval flag. */
export function resolveDecisions(decisions: ActiveDecision[]) {
  let decisive: ActiveDecision | null = null;
  for (const d of decisions) {
    if (d.action === 'manual_approval' || d.action === 'default') continue;
    if (!decisive || ACTION_RANK[d.action] > ACTION_RANK[decisive.action]
      || (ACTION_RANK[d.action] === ACTION_RANK[decisive.action] && d.scope === 'platform')) decisive = d;
  }
  const manual = decisions.filter((d) => d.action === 'manual_approval');
  return { decisive, rank: decisive ? ACTION_RANK[decisive.action] : 0, manual: manual.length > 0, manualDecision: manual[0] ?? null };
}

export async function computePaymentTerms(trx: Tx, input: PaymentTermsInput): Promise<PaymentTerms> {
  const now = input.now ?? new Date();
  if (!Number.isSafeInteger(input.amountDueMinor) || input.amountDueMinor < 0) throw Errors.invalid('invalid_amount');

  // ── 2. Policy snapshot + decisions ───────────────────────────────────────
  const settings = await trx.selectFrom('tenant_settings')
    .select(['deposit_mode', 'deposit_percent_bp', 'deposit_fixed_minor', 'allow_full_prepay', 'allow_pay_on_site', 'hold_ttl_sec'])
    .where('tenant_id', '=', input.tenantId).executeTakeFirst();
  if (!settings) throw Errors.notFound('business settings');

  let customerUserId = input.customerUserId;
  if (input.tenantCustomerId) {
    const tc = await trx.selectFrom('tenant_customers').select(['user_id']).where('id', '=', input.tenantCustomerId).where('tenant_id', '=', input.tenantId).executeTakeFirst();
    if (!tc) throw Errors.notFound('customer');
    if (customerUserId && tc.user_id && tc.user_id !== customerUserId) throw Errors.invalid('customer_mismatch');
    customerUserId = customerUserId ?? tc.user_id;
  }
  const decisions = await activeDecisionsFor(trx, input.tenantId, input.tenantCustomerId, customerUserId, now);
  const { decisive, rank, manual, manualDecision } = resolveDecisions(decisions);

  const reasonCodes: string[] = [];
  for (const d of decisions) reasonCodes.push(`${d.scope}_decision:${d.action}`);

  // ── 1. Methods ───────────────────────────────────────────────────────────
  const methods = [...new Set(input.availableMethods)];
  const hasOnline = methods.some((m) => !ONSITE_METHODS.has(m));
  const hasOnsiteMethod = methods.some((m) => ONSITE_METHODS.has(m));
  if (!hasOnline) reasonCodes.push('no_online_method');
  if (!hasOnsiteMethod) reasonCodes.push('no_on_site_method');
  if (!settings.allow_pay_on_site) reasonCodes.push('on_site_disabled_by_business');

  const amount = input.amountDueMinor;
  const isBooking = input.context === 'booking';
  const rawDeposit = isBooking ? depositFor(amount, settings) : 0;
  const businessRequiresUpfront = isBooking && settings.deposit_mode !== 'none' && rawDeposit > 0;
  const depositOption = rawDeposit > 0 && rawDeposit < amount ? rawDeposit : null;
  if (businessRequiresUpfront) reasonCodes.push('business_deposit_policy');
  if (rawDeposit > 0 && rawDeposit >= amount) reasonCodes.push('deposit_equals_total');

  // ── 3/4. Candidate options, then restrictions ────────────────────────────
  const allowed = new Set<PaymentOption>();
  let blockedBySuspension = false;
  if (decisive?.action === 'suspend_account') {
    blockedBySuspension = true;
    reasonCodes.push('account_suspended');
  } else if (amount === 0) {
    allowed.add('full');
    reasonCodes.push('nothing_due');
  } else {
    if (hasOnline && (settings.allow_full_prepay || rank >= 1 || businessRequiresUpfront)) allowed.add('full');
    if (hasOnline && depositOption !== null) allowed.add('deposit');
    if (hasOnsiteMethod && settings.allow_pay_on_site && !businessRequiresUpfront) allowed.add('on_site');

    if (rank >= 2) {
      allowed.delete('deposit');
      allowed.delete('on_site');
      reasonCodes.push('restriction:full_payment_required');
    } else if (rank === 1) {
      allowed.delete('on_site');
      reasonCodes.push('restriction:deposit_required');
      if (!allowed.has('deposit')) reasonCodes.push('deposit_unavailable_full_required');
    }
  }

  // ── 5. Blocked → contact path ────────────────────────────────────────────
  const order: PaymentOption[] = ['full', 'deposit', 'on_site'];
  const allowedList = order.filter((o) => allowed.has(o));
  const blocked = blockedBySuspension || allowedList.length === 0;
  if (blocked && !blockedBySuspension) reasonCodes.push('no_compatible_method');
  if (manual) reasonCodes.push('manual_approval_required');

  // ── 6. Customer explanation ──────────────────────────────────────────────
  let customerExplanation: { ar: string; en: string } | null = null;
  const explaining = decisive ?? manualDecision;
  if (explaining || blocked) {
    const base = explaining
      ? {
        ar: explaining.explanation_ar || genericExplanation(explaining.action).ar,
        en: explaining.explanation_en || genericExplanation(explaining.action).en,
      }
      : { ar: '', en: '' };
    const tail = blocked ? genericExplanation('blocked') : explaining ? genericExplanation('appeal') : { ar: '', en: '' };
    customerExplanation = { ar: [base.ar, tail.ar].filter(Boolean).join(' '), en: [base.en, tail.en].filter(Boolean).join(' ') };
  }

  const computedAt = now;
  const validUntil = new Date(now.getTime() + settings.hold_ttl_sec * 1000);
  return {
    allowed: blocked ? [] : allowedList,
    depositMinor: !blocked && allowed.has('deposit') ? depositOption : null,
    amountDueMinor: amount,
    requiresManualApproval: manual,
    blocked,
    reasonCodes: [...new Set(reasonCodes)],
    decisionIds: decisions.map((d) => d.id),
    customerExplanation,
    policySnapshot: {
      algorithm_version: TERMS_ALGORITHM_VERSION,
      context: input.context,
      available_methods: methods,
      deposit_mode: settings.deposit_mode,
      deposit_percent_bp: settings.deposit_percent_bp,
      deposit_fixed_minor: settings.deposit_fixed_minor,
      deposit_rounding: 'half_up',
      allow_full_prepay: settings.allow_full_prepay,
      allow_pay_on_site: settings.allow_pay_on_site,
      hold_ttl_sec: settings.hold_ttl_sec,
      effective_action: blockedBySuspension ? 'suspend_account' : decisive?.action ?? 'default',
      // Scope + action only: tenants never see platform reasons or evidence.
      decisions: decisions.map((d) => ({ id: d.id, scope: d.scope, action: d.action })),
      appeal_path: APPEAL_PATH,
      contact_path: blocked || manual ? 'contact_business' : null,
    },
    computedAt: computedAt.toISOString(),
    validUntil: validUntil.toISOString(),
  };
}

export type TermsReassessment = {
  terms: PaymentTerms;
  /** Material terms differ: checkout must ask the customer to re-confirm before creating a payment. */
  changed: boolean;
  changes: Array<'allowed' | 'deposit' | 'amount' | 'manual_approval' | 'blocked'>;
  /** The previous terms passed their validUntil. */
  expired: boolean;
};

/** Recomputes terms during a hold/checkout and reports material changes. */
export async function reassessPaymentTerms(trx: Tx, previous: PaymentTerms, input: PaymentTermsInput): Promise<TermsReassessment> {
  const terms = await computePaymentTerms(trx, input);
  const changes: TermsReassessment['changes'] = [];
  const a = [...previous.allowed].sort().join(','), b = [...terms.allowed].sort().join(',');
  if (a !== b) changes.push('allowed');
  if ((previous.depositMinor ?? null) !== (terms.depositMinor ?? null)) changes.push('deposit');
  if (previous.amountDueMinor !== terms.amountDueMinor) changes.push('amount');
  if (previous.requiresManualApproval !== terms.requiresManualApproval) changes.push('manual_approval');
  if (previous.blocked !== terms.blocked) changes.push('blocked');
  const now = input.now ?? new Date();
  return { terms, changed: changes.length > 0, changes, expired: new Date(previous.validUntil).getTime() < now.getTime() };
}

/** Server-side guard for checkout: the chosen option must be one the server allowed. */
export function requireAllowedOption(terms: PaymentTerms, option: PaymentOption) {
  if (terms.blocked) throw Errors.conflict('payment_blocked', 'No payment option is available for this customer; contact the business.', { reason_codes: terms.reasonCodes });
  if (!terms.allowed.includes(option)) throw Errors.invalid('payment_option_not_allowed', 'This payment option is not available', { allowed: terms.allowed });
}
