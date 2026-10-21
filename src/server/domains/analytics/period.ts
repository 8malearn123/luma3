import { DateTime } from 'luxon';
import { Errors } from '../../http/errors';

export type Period = {
  from: string;
  to: string;
  /** Inclusive start instant (local midnight of `from`). */
  start: Date;
  /** Exclusive end instant (local midnight after `to`). */
  end: Date;
  days: number;
  timezone: string;
};

/** Today's calendar date in a timezone (YYYY-MM-DD). */
export function localToday(tz: string, now = new Date()): string {
  return DateTime.fromJSDate(now, { zone: tz }).toISODate()!;
}

export function addDays(date: string, n: number): string {
  return DateTime.fromISO(date, { zone: 'UTC' }).plus({ days: n }).toISODate()!;
}

export function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Local wall-clock (date + HH:MM[:SS]) in a zone → epoch ms. */
export function localToMs(date: string, time: string, tz: string): number {
  return DateTime.fromISO(`${date}T${time.length === 5 ? `${time}:00` : time}`, { zone: tz }).toMillis();
}

/** 0 = Sunday … 6 = Saturday, matching working_hours.weekday. */
export function weekdayOf(date: string): number {
  return DateTime.fromISO(date, { zone: 'UTC' }).weekday % 7;
}

/** Local hour (0-23) of an instant in a zone. */
export function localHour(ms: number, tz: string): number {
  return DateTime.fromMillis(ms, { zone: tz }).hour;
}

/**
 * Resolves a reporting period in the business timezone. Days are tenant-local
 * calendar days; the instants are the local midnights converted to UTC.
 */
export function resolvePeriod(tz: string, from?: string, to?: string, defaultDays = 30, now = new Date()): Period {
  const today = localToday(tz, now);
  const end = to ?? (from ? addDays(from, defaultDays - 1) : today);
  const start = from ?? addDays(end, -(defaultDays - 1));
  if (start > end) throw Errors.invalid('invalid_period', 'from must be on or before to');
  const days = Math.round(DateTime.fromISO(end).diff(DateTime.fromISO(start), 'days').days) + 1;
  if (days > 366) throw Errors.invalid('invalid_period', 'The period cannot exceed 366 days');
  return {
    from: start, to: end, days, timezone: tz,
    start: DateTime.fromISO(start, { zone: tz }).startOf('day').toJSDate(),
    end: DateTime.fromISO(end, { zone: tz }).plus({ days: 1 }).startOf('day').toJSDate(),
  };
}
