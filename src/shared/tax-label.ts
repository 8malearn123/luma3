/**
 * The business types its tax label once (usually in Arabic, e.g. «ضريبة القيمة
 * المضافة»). In the English UI an Arabic-only label is replaced by the
 * localized generic label so the line is not mixed-language (LUMA-AUDIT-039).
 */
const ARABIC = /[؀-ۿ]/;
const LATIN = /[A-Za-z]/;

export function localizedTaxLabel(label: string | null | undefined, locale: 'ar' | 'en', fallback: string) {
  const l = label?.trim();
  if (!l) return fallback;
  if (locale === 'en' && ARABIC.test(l) && !LATIN.test(l)) return fallback;
  return l;
}
