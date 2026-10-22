/** Payment vocabulary shared by checkout, payment terms (policy) and providers. */
export const PAYMENT_METHODS = ['card', 'mada', 'apple_pay', 'tabby', 'tamara', 'cash', 'pos_terminal', 'gift_card', 'sandbox'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/** How much is collected and when. */
export const PAYMENT_OPTIONS = ['full', 'deposit', 'on_site'] as const;
export type PaymentOption = (typeof PAYMENT_OPTIONS)[number];

/**
 * Result of the payment-terms algorithm (spec §20). Computed server-side,
 * snapshotted into the booking/order, and never re-enabled by the browser.
 */
export type PaymentTerms = {
  allowed: PaymentOption[];
  depositMinor: number | null;
  amountDueMinor: number;
  requiresManualApproval: boolean;
  /** No compatible way to pay: offer contact/manual-approval path instead of an unpayable booking. */
  blocked: boolean;
  reasonCodes: string[];
  decisionIds: string[];
  customerExplanation: { ar: string; en: string } | null;
  policySnapshot: Record<string, unknown>;
  computedAt: string;
  validUntil: string;
};
