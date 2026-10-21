import { sql, type Tx } from '../../db/client';
import { dateRange, localHour, localToMs, weekdayOf } from './period';

/**
 * Occupancy = booked service minutes ÷ available working minutes, for the same
 * period and scope (per specialist, then totals).
 *
 * Available minutes per specialist and local day:
 *   working_hours (weekday, effective range, branch timezone)
 *   → shift_overrides: 'off' clears the day, 'replace' replaces the hours, 'extra' adds hours
 *   − staff_breaks (weekly or dated) − approved leave − staff time blocks.
 * Booked minutes: booking_items of bookings in confirmed / checked_in /
 * in_service / completed, intersected with the available windows. Booked time
 * outside the windows is reported separately (booked_outside_min), never used
 * to inflate occupancy above what the schedule offered.
 */

type Interval = [number, number];
export const OCCUPYING_STATUSES = ['confirmed', 'checked_in', 'in_service', 'completed'] as const;

export function merge(list: Interval[]): Interval[] {
  const s = list.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out: Interval[] = [];
  for (const iv of s) {
    const last = out[out.length - 1];
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
    else out.push([iv[0], iv[1]]);
  }
  return out;
}

export function subtract(base: Interval[], cut: Interval[]): Interval[] {
  let cur = merge(base);
  for (const [cs, ce] of merge(cut)) {
    const next: Interval[] = [];
    for (const [s, e] of cur) {
      if (ce <= s || cs >= e) { next.push([s, e]); continue; }
      if (cs > s) next.push([s, cs]);
      if (ce < e) next.push([ce, e]);
    }
    cur = next;
  }
  return cur;
}

export function intersect(a: Interval[], b: Interval[]): Interval[] {
  const out: Interval[] = [];
  for (const [as, ae] of a) for (const [bs, be] of b) {
    const s = Math.max(as, bs), e = Math.min(ae, be);
    if (e > s) out.push([s, e]);
  }
  return merge(out);
}

const minutes = (ivs: Interval[]) => ivs.reduce((m, [s, e]) => m + (e - s), 0) / 60_000;

/** Unbounded range ends are treated as far past/future. */
function toInterval(r: { s: Date | null; e: Date | null }): Interval {
  return [r.s ? r.s.getTime() : -8.64e15, r.e ? r.e.getTime() : 8.64e15];
}

export type Daypart = 'morning' | 'afternoon' | 'evening';
export const daypartOf = (hour: number): Daypart => (hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening');

export type StaffOccupancy = {
  staff_id: string;
  display_name: string;
  available_min: number;
  booked_min: number;
  booked_outside_min: number;
  occupancy: number | null;
  days: Array<{ date: string; available_min: number; booked_min: number }>;
};

export type OccupancyResult = {
  from: string; to: string; timezone: string;
  staff: StaffOccupancy[];
  totals: { available_min: number; booked_min: number; booked_outside_min: number; occupancy: number | null };
  /** Weekday (0=Sun) × daypart buckets, tenant-local. */
  buckets: Array<{ weekday: number; daypart: Daypart; available_min: number; booked_min: number; occupancy: number | null }>;
};

/** Splits intervals into tenant-local (weekday, daypart) minute buckets. */
function bucketize(ivs: Interval[], tz: string, into: Map<string, number>) {
  for (const [s, e] of ivs) {
    let t = s;
    while (t < e) {
      const next = Math.min(e, (Math.floor(t / 3_600_000) + 1) * 3_600_000);
      const d = new Date(t);
      const date = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
      const key = `${weekdayOf(date)}:${daypartOf(localHour(t, tz))}`;
      into.set(key, (into.get(key) ?? 0) + (next - t) / 60_000);
      t = next;
    }
  }
}

export async function computeOccupancy(trx: Tx, tenantId: string, tenantTz: string, from: string, to: string, opts: { staffIds?: string[] } = {}): Promise<OccupancyResult> {
  const startMs = localToMs(from, '00:00', tenantTz);
  const endMs = localToMs(to, '00:00', tenantTz) + 86_400_000 + 3_600_000 * 2; // tolerate DST/branch tz offsets
  const start = new Date(startMs - 86_400_000), end = new Date(endMs);
  const staffFilter = opts.staffIds?.length ? opts.staffIds : null;

  let staffQ = trx.selectFrom('staff_profiles').select(['id', 'display_name']).where('tenant_id', '=', tenantId).where('archived_at', 'is', null);
  if (staffFilter) staffQ = staffQ.where('id', 'in', staffFilter);
  const staff = await staffQ.execute();
  const ids = staff.map((s) => s.id);
  const empty: OccupancyResult = { from, to, timezone: tenantTz, staff: [], totals: { available_min: 0, booked_min: 0, booked_outside_min: 0, occupancy: null }, buckets: [] };
  if (!ids.length) return empty;

  const [hours, breaks, overrides, leave, blocks, items] = await Promise.all([
    trx.selectFrom('working_hours as w').innerJoin('branches as b', (j) => j.onRef('b.id', '=', 'w.branch_id').onRef('b.tenant_id', '=', 'w.tenant_id'))
      .select(['w.staff_id', 'w.weekday', 'w.start_time', 'w.end_time', 'w.effective_from', 'w.effective_to', 'b.timezone'])
      .where('w.tenant_id', '=', tenantId).where('w.staff_id', 'in', ids).execute(),
    trx.selectFrom('staff_breaks').select(['staff_id', 'weekday', 'on_date', 'start_time', 'end_time']).where('tenant_id', '=', tenantId).where('staff_id', 'in', ids).execute(),
    trx.selectFrom('shift_overrides as o').innerJoin('branches as b', (j) => j.onRef('b.id', '=', 'o.branch_id').onRef('b.tenant_id', '=', 'o.tenant_id'))
      .select(['o.staff_id', 'o.on_date', 'o.kind', 'o.start_time', 'o.end_time', 'b.timezone'])
      .where('o.tenant_id', '=', tenantId).where('o.staff_id', 'in', ids).where('o.on_date', '>=', from).where('o.on_date', '<=', to).execute(),
    sql<{ staff_id: string; s: Date | null; e: Date | null }>`select staff_id, lower(during) as s, upper(during) as e from leave_requests
      where tenant_id = ${tenantId} and status = 'approved' and staff_id = any(${ids}::uuid[]) and during && tstzrange(${start}, ${end})`.execute(trx),
    sql<{ staff_id: string; s: Date | null; e: Date | null }>`select staff_id, lower(during) as s, upper(during) as e from time_blocks
      where tenant_id = ${tenantId} and staff_id = any(${ids}::uuid[]) and during && tstzrange(${start}, ${end})`.execute(trx),
    sql<{ staff_id: string; starts_at: Date; ends_at: Date }>`select bi.staff_id, bi.starts_at, bi.ends_at from booking_items bi
      join bookings bk on bk.id = bi.booking_id and bk.tenant_id = bi.tenant_id
      where bi.tenant_id = ${tenantId} and bi.staff_id = any(${ids}::uuid[]) and bk.status in ('confirmed', 'checked_in', 'in_service', 'completed')
        and bi.starts_at < ${end} and bi.ends_at > ${start}`.execute(trx),
  ]);

  const days = dateRange(from, to);
  const availBuckets = new Map<string, number>();
  const bookedBuckets = new Map<string, number>();
  const result: StaffOccupancy[] = [];
  const toTime = (t: string) => t.slice(0, 8);

  for (const id of ids) {
    const myHours = hours.filter((h) => h.staff_id === id);
    const tzForBreaks = myHours[0]?.timezone ?? tenantTz;
    const myLeave = leave.rows.filter((l) => l.staff_id === id).map(toInterval);
    const myBlocks = blocks.rows.filter((l) => l.staff_id === id).map(toInterval);
    const myItems = merge(items.rows.filter((i) => i.staff_id === id).map((i) => [i.starts_at.getTime(), i.ends_at.getTime()] as Interval));
    let available: Interval[] = [];
    const perDay: StaffOccupancy['days'] = [];
    for (const d of days) {
      const wd = weekdayOf(d);
      let base: Interval[] = myHours
        .filter((h) => h.weekday === wd && (!h.effective_from || h.effective_from <= d) && (!h.effective_to || h.effective_to >= d))
        .map((h) => [localToMs(d, toTime(h.start_time), h.timezone), localToMs(d, toTime(h.end_time), h.timezone)] as Interval);
      const ovs = overrides.filter((o) => o.staff_id === id && o.on_date === d);
      if (ovs.some((o) => o.kind === 'off')) base = [];
      else {
        const repl = ovs.filter((o) => o.kind === 'replace');
        if (repl.length) base = repl.map((o) => [localToMs(d, toTime(o.start_time!), o.timezone), localToMs(d, toTime(o.end_time!), o.timezone)] as Interval);
        base.push(...ovs.filter((o) => o.kind === 'extra').map((o) => [localToMs(d, toTime(o.start_time!), o.timezone), localToMs(d, toTime(o.end_time!), o.timezone)] as Interval));
      }
      const br = breaks.filter((b) => b.staff_id === id && (b.on_date === d || (b.on_date === null && b.weekday === wd)))
        .map((b) => [localToMs(d, toTime(b.start_time), tzForBreaks), localToMs(d, toTime(b.end_time), tzForBreaks)] as Interval);
      const dayAvail = subtract(subtract(subtract(base, br), myLeave), myBlocks);
      const dayBooked = intersect(dayAvail, myItems);
      perDay.push({ date: d, available_min: Math.round(minutes(dayAvail)), booked_min: Math.round(minutes(dayBooked)) });
      available = available.concat(dayAvail);
    }
    available = merge(available);
    const booked = intersect(available, myItems);
    const periodWindow: Interval[] = [[startMs, localToMs(to, '00:00', tenantTz) + 86_400_000]];
    const itemsInPeriod = intersect(myItems, periodWindow);
    bucketize(available, tenantTz, availBuckets);
    bucketize(booked, tenantTz, bookedBuckets);
    const a = minutes(available), b = minutes(booked);
    result.push({
      staff_id: id, display_name: staff.find((x) => x.id === id)?.display_name ?? '', available_min: Math.round(a), booked_min: Math.round(b),
      booked_outside_min: Math.max(0, Math.round(minutes(itemsInPeriod) - b)),
      occupancy: a > 0 ? b / a : null, days: perDay,
    });
  }
  const ta = result.reduce((m, r) => m + r.available_min, 0);
  const tb = result.reduce((m, r) => m + r.booked_min, 0);
  const buckets: OccupancyResult['buckets'] = [];
  for (let wd = 0; wd < 7; wd++) for (const dp of ['morning', 'afternoon', 'evening'] as const) {
    const av = Math.round(availBuckets.get(`${wd}:${dp}`) ?? 0), bk = Math.round(bookedBuckets.get(`${wd}:${dp}`) ?? 0);
    if (av > 0) buckets.push({ weekday: wd, daypart: dp, available_min: av, booked_min: bk, occupancy: bk / av });
  }
  return {
    from, to, timezone: tenantTz, staff: result,
    totals: { available_min: ta, booked_min: tb, booked_outside_min: result.reduce((m, r) => m + r.booked_outside_min, 0), occupancy: ta > 0 ? tb / ta : null },
    buckets,
  };
}
