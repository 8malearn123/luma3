import { sandboxProvider } from './sandbox';
import type { PaymentProvider, ProviderName } from './types';

/**
 * Only providers with a working adapter are registered. Moyasar, Tap, Tabby
 * and Tamara are NOT integrated in this delivery (no verified credentials or
 * contracts); their methods are therefore never offered to customers.
 */
const providers: Partial<Record<ProviderName, PaymentProvider>> = { sandbox: sandboxProvider };

export function provider(name: string): PaymentProvider | null {
  return providers[name as ProviderName] ?? null;
}

export const PROVIDER_CATALOG: Array<{ name: ProviderName; integrated: boolean; note_ar: string; note_en: string }> = [
  { name: 'sandbox', integrated: true, note_ar: 'مزوّد تجريبي من لوما — لا ينقل أموالاً حقيقية.', note_en: 'LUMA test provider — moves no real money.' },
  { name: 'moyasar', integrated: false, note_ar: 'غير مدمج بعد — يتطلب حساب تاجر وتحققاً من الواجهة البرمجية.', note_en: 'Not integrated yet — requires a merchant account and API verification.' },
  { name: 'tap', integrated: false, note_ar: 'غير مدمج بعد.', note_en: 'Not integrated yet.' },
  { name: 'tabby', integrated: false, note_ar: 'غير مدمج بعد — الدفع بالتقسيط يتطلب اتفاقية.', note_en: 'Not integrated yet — BNPL requires an agreement.' },
  { name: 'tamara', integrated: false, note_ar: 'غير مدمج بعد — الدفع بالتقسيط يتطلب اتفاقية.', note_en: 'Not integrated yet — BNPL requires an agreement.' },
];
