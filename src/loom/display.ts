import { metricDefinition, type MetricUnit } from './metrics/registry';
import './metrics/v1';
import { L, render, type Localized, type LoomLocale } from './util/text';

/**
 * Owner-facing display helpers (LUMA-AUDIT-023/024). Internal metric keys
 * (`inventory.weekly_usage@item:<uuid>`), grain refs and minor units never
 * reach the owner as such: every metric is shown with its registry label, the
 * name of what it measures (offering, item, weekday/daypart) and a unit the
 * UI formats (money from minor units in the business currency).
 */

const DAYPART: Record<string, Localized> = { morning: L('الصباح', 'morning'), afternoon: L('الظهيرة', 'afternoon'), evening: L('المساء', 'evening') };
const WEEKDAY: Localized[] = [L('الأحد', 'Sunday'), L('الاثنين', 'Monday'), L('الثلاثاء', 'Tuesday'), L('الأربعاء', 'Wednesday'), L('الخميس', 'Thursday'), L('الجمعة', 'Friday'), L('السبت', 'Saturday')];

/** Names of the things a metric can be about: offering and inventory-item ids → localized name. */
export type SubjectNames = ReadonlyMap<string, Localized>;

/** `inventory.weekly_usage@item:<id>` → { base: 'inventory.weekly_usage', grain: 'item:<id>' }. */
export function splitMetricKey(key: string): { base: string; grain: string } {
  const at = key.indexOf('@');
  return at < 0 ? { base: key, grain: 'business' } : { base: key.slice(0, at), grain: key.slice(at + 1) || 'business' };
}

/** The readable subject of a grain ref, or null for the whole business. */
export function grainLabel(grain: string, names: SubjectNames, locale: LoomLocale): string | null {
  if (!grain || grain === 'business') return null;
  const i = grain.indexOf(':');
  const kind = i < 0 ? grain : grain.slice(0, i);
  const ref = i < 0 ? '' : grain.slice(i + 1);
  if (kind === 'slot') {
    const [wd, dp] = ref.split('.');
    const day = WEEKDAY[Number(wd)];
    const part = DAYPART[dp ?? ''];
    return day && part ? render(L(`${day.ar} ${part.ar}`, `${day.en} ${part.en}`), locale) : null;
  }
  const name = names.get(ref);
  if (name) return render(name, locale);
  // An id we cannot name (archived, other connector): say what kind of thing it is, never the raw id.
  const generic: Record<string, Localized> = {
    offering: L('خدمة أو منتج', 'a service or product'), item: L('صنف مخزون', 'an inventory item'), resource: L('أحد أفراد الفريق', 'a team member'),
    channel: L('قناة', 'a channel'), source: L('مصدر', 'a source'), campaign: L('حملة', 'a campaign'), day: L('يوم', 'a day'),
  };
  return generic[kind] ? render(generic[kind]!, locale) : null;
}

/** Unit of a metric key (with or without a grain suffix); null when unknown (legacy keys are guessed by their name). */
export function metricUnit(key: string): MetricUnit | null {
  const { base } = splitMetricKey(key);
  const d = metricDefinition(base);
  if (d) return d.unit;
  if (/_minor$|revenue|net_sales|\.net$|amount/.test(base)) return 'minor';
  if (/occupancy|rate|ratio|share/.test(base)) return 'ratio';
  if (/minutes|_min$|free_min/.test(base)) return 'minutes';
  if (/rating/.test(base)) return 'rating';
  if (/days/.test(base)) return 'days';
  return null;
}

/** A readable label for a metric key: «الاستهلاك الأسبوعي — شامبو مرطب» instead of `inventory.weekly_usage@item:<uuid>`. */
export function metricLabel(key: string, names: SubjectNames, locale: LoomLocale, fallback?: string | null): string {
  const { base, grain } = splitMetricKey(key);
  const d = metricDefinition(base);
  const label = d ? render(d.label, locale) : (fallback && !fallback.includes('.') ? fallback : null);
  const subject = grainLabel(grain, names, locale);
  const head = label ?? (locale === 'ar' ? 'مؤشر' : 'Indicator');
  return subject ? `${head} — ${subject}` : head;
}

/** Display fields for one metric (label + unit) to send next to its raw value. */
export function metricDisplay(key: string, names: SubjectNames, locale: LoomLocale, fallback?: string | null) {
  return { label: metricLabel(key, names, locale, fallback), unit: metricUnit(key) };
}

export { moneyText } from './util/text';
