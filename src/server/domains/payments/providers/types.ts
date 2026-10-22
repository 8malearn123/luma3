import type { PaymentMethod } from '@/shared/payments';

/**
 * Payment provider adapter. A real provider (e.g. a Saudi gateway supporting
 * mada / Apple Pay, or a BNPL provider) implements this interface after its
 * actual API and settlement model are verified. Card data never touches LUMA:
 * checkout is always hosted by the provider (PAN/CVV are never stored).
 */
export type ProviderName = 'sandbox' | 'moyasar' | 'tap' | 'tabby' | 'tamara';

export type CreateCheckout = {
  paymentId: string; amountMinor: number; currency: string; accountRef: string; description: string;
  returnUrl: string; metadata: Record<string, string>;
};

export type VerifiedEvent = {
  eventId: string;
  type: 'payment.captured' | 'payment.failed' | 'payment.cancelled' | 'refund.succeeded' | 'refund.failed';
  createdAt: Date;
  providerPaymentId: string;
  providerRefundId?: string;
  amountMinor: number;
  currency: string;
  accountRef: string;
  raw: unknown;
};

export interface PaymentProvider {
  readonly name: ProviderName;
  /** Methods this adapter can actually process (shown only if also enabled on the account). */
  readonly supportedMethods: PaymentMethod[];
  readonly isSimulation: boolean;
  createCheckout(req: CreateCheckout): Promise<{ providerPaymentId: string; checkoutUrl: string }>;
  refund(req: { providerPaymentId: string; amountMinor: number; currency: string; idempotencyKey: string }): Promise<{ providerRefundId: string; status: 'pending' | 'succeeded' | 'failed' }>;
  /** Verifies signature, timestamp tolerance and shape. Throws on forgery/replay window violation. */
  verifyWebhook(rawBody: string, headers: Headers, now?: Date): VerifiedEvent;
  /** Provider-side record for reconciliation. */
  fetchPayment(providerPaymentId: string): Promise<{ status: string; amountMinor: number; currency: string; refundedMinor: number } | null>;
}

export class WebhookVerificationError extends Error {}
