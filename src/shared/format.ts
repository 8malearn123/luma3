/**
 * Locale-aware formatting. Money is integer minor units (halalas). Instants are
 * stored in UTC and always displayed in an explicit timezone (default
 * Asia/Riyadh) with 12/24-hour display that never changes stored values.
 */
export type Locale = 'ar' | 'en';
const intlLocale = (l: Locale) => (l === 'ar' ? 'ar-SA-u-nu-latn' : 'en-SA');

export function formatMoney(minor: number | null | undefined, currency = 'SAR', locale: Locale = 'ar') {
  if (minor == null) return '—';
  return new Intl.NumberFormat(intlLocale(locale), { style: 'currency', currency, minimumFractionDigits: minor % 100 === 0 ? 0 : 2, maximumFractionDigits: 2 }).format(minor / 100);
}

export function toMinor(major: number) {
  return Math.round(major * 100);
}

export function formatDateTime(v: string | Date, opts: { tz?: string; locale?: Locale; timeFormat?: '12h' | '24h'; date?: boolean; time?: boolean; weekday?: boolean } = {}) {
  const d = typeof v === 'string' ? new Date(v) : v;
  const { tz = 'Asia/Riyadh', locale = 'ar', timeFormat = '12h', date = true, time = true, weekday = false } = opts;
  return new Intl.DateTimeFormat(intlLocale(locale), {
    timeZone: tz,
    ...(date ? { year: 'numeric', month: 'short', day: 'numeric' } : {}),
    ...(weekday ? { weekday: 'long' } : {}),
    ...(time ? { hour: 'numeric', minute: '2-digit', hour12: timeFormat === '12h' } : {}),
  }).format(d);
}

export function formatTime(v: string | Date, opts: { tz?: string; locale?: Locale; timeFormat?: '12h' | '24h' } = {}) {
  return formatDateTime(v, { ...opts, date: false, time: true });
}

export function formatDate(v: string | Date, opts: { tz?: string; locale?: Locale; weekday?: boolean } = {}) {
  return formatDateTime(v, { ...opts, date: true, time: false });
}

/** Formats a local wall-clock "HH:MM" string without involving timezones. */
export function formatClock(hhmm: string, locale: Locale = 'ar', timeFormat: '12h' | '24h' = '12h') {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  if (timeFormat === '24h') return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  const suffix = locale === 'ar' ? (h < 12 ? 'ص' : 'م') : h < 12 ? 'AM' : 'PM';
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')} ${suffix}`;
}

export function tzLabel(tz: string, locale: Locale = 'ar') {
  if (tz === 'Asia/Riyadh') return locale === 'ar' ? 'بتوقيت الرياض' : 'Riyadh time';
  return tz;
}

export function formatDuration(min: number, locale: Locale = 'ar') {
  const h = Math.floor(min / 60), m = min % 60;
  if (locale === 'ar') return [h ? `${h} س` : '', m ? `${m} د` : ''].filter(Boolean).join(' ');
  return [h ? `${h}h` : '', m ? `${m}m` : ''].filter(Boolean).join(' ');
}

export function formatNumber(n: number, locale: Locale = 'ar', opts: Intl.NumberFormatOptions = {}) {
  return new Intl.NumberFormat(intlLocale(locale), opts).format(n);
}

export const WEEKDAYS: Record<Locale, string[]> = {
  ar: ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'],
  en: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
};
