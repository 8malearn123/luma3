import { DateTime } from 'luxon';

/** Calendar helpers (pure). Dates are YYYY-MM-DD in the business timezone. */
export const DAY_MS = 86_400_000;
export function localToday(tz: string, now = new Date()): string { return DateTime.fromJSDate(now, { zone: tz }).toISODate()!; }
export function addDays(date: string, n: number): string { return DateTime.fromISO(date, { zone: 'UTC' }).plus({ days: n }).toISODate()!; }
export function dateRange(from: string, to: string): string[] { const out: string[] = []; for (let d = from; d <= to; d = addDays(d, 1)) out.push(d); return out; }
export function localToMs(date: string, time: string, tz: string): number { return DateTime.fromISO(`${date}T${time.length === 5 ? `${time}:00` : time.slice(0, 8)}`, { zone: tz }).toMillis(); }
/** 0 = Sunday … 6 = Saturday. */
export function weekdayOf(date: string): number { return DateTime.fromISO(date, { zone: 'UTC' }).weekday % 7; }
export function localDateOf(ms: number, tz: string): string { return DateTime.fromMillis(ms, { zone: tz }).toISODate()!; }
export function localHour(ms: number, tz: string): number { return DateTime.fromMillis(ms, { zone: tz }).hour; }
export type Daypart = 'morning' | 'afternoon' | 'evening';
export const daypartOf = (hour: number): Daypart => (hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening');
export const monthKey = (date: string) => date.slice(0, 7);

export type Interval = [number, number];
export function merge(list: Interval[]): Interval[] {
  const s = list.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out: Interval[] = [];
  for (const iv of s) { const last = out[out.length - 1]; if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]); else out.push([iv[0], iv[1]]); }
  return out;
}
export function subtract(base: Interval[], cut: Interval[]): Interval[] {
  let cur = merge(base);
  for (const [cs, ce] of merge(cut)) {
    const next: Interval[] = [];
    for (const [s, e] of cur) { if (ce <= s || cs >= e) { next.push([s, e]); continue; } if (cs > s) next.push([s, cs]); if (ce < e) next.push([ce, e]); }
    cur = next;
  }
  return cur;
}
export function intersect(a: Interval[], b: Interval[]): Interval[] {
  const out: Interval[] = [];
  for (const [as, ae] of a) for (const [bs, be] of b) { const s = Math.max(as, bs), e = Math.min(ae, be); if (e > s) out.push([s, e]); }
  return merge(out);
}
export const minutesOf = (ivs: Interval[]) => ivs.reduce((m, [s, e]) => m + (e - s), 0) / 60_000;
