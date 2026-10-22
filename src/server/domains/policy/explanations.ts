/**
 * Customer-facing wording used when a decision has no custom explanation.
 * Neutral, booking-terms only: never mentions other businesses' reports,
 * employees, or any "list" the customer is on.
 */
const TEXT: Record<string, { ar: string; en: string }> = {
  default: { ar: 'تطبق شروط الحجز المعتادة.', en: 'Standard booking terms apply.' },
  require_deposit: { ar: 'يتطلب الحجز دفع عربون مقدماً.', en: 'A deposit is required to confirm bookings.' },
  require_full_payment: { ar: 'يتطلب الحجز دفع المبلغ كاملاً مقدماً.', en: 'Full prepayment is required to confirm bookings.' },
  manual_approval: { ar: 'تحتاج حجوزاتك إلى تأكيد من النشاط قبل اعتمادها.', en: 'Your bookings need to be confirmed by the business before they are final.' },
  suspend_account: { ar: 'الحجز والشراء عبر لوما متوقفان مؤقتاً لحسابك.', en: 'Booking and purchasing through LUMA are temporarily paused for your account.' },
  blocked: { ar: 'لا توجد طريقة دفع متاحة لهذا الحجز حالياً. تواصلي مع النشاط مباشرة لترتيب الحجز.', en: 'No payment option is available for this booking right now. Please contact the business directly to arrange it.' },
  appeal: { ar: 'يمكنكِ مراجعة التفاصيل وتقديم طلب مراجعة من صفحة حسابك.', en: 'You can review the details and request a review from your account.' },
};

export function genericExplanation(key: string): { ar: string; en: string } {
  return TEXT[key] ?? TEXT.default!;
}
