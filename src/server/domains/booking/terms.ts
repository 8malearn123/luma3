/**
 * Single import point for the payment-terms algorithm so the booking and
 * checkout code does not depend on where it lives.
 */
export { computePaymentTerms, reassessPaymentTerms, requireAllowedOption } from '../policy/payment-terms';
