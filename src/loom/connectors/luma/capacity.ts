import type { CapacityWindow } from '../../contracts/canonical';
import { dateRange, intersect, localToMs, merge, subtract, weekdayOf, type Interval } from '../../util/time';

/**
 * Turns LUMA schedule primitives into canonical CapacityWindow records
 * (same rules as LUMA's occupancy report):
 *   working hours (weekday, effective range, branch timezone)
 *   → shift overrides ('off' clears, 'replace' replaces, 'extra' adds)
 *   − breaks and staff time blocks  → 'blocked'
 *   − approved leave                → 'leave'
 *   remaining time ∩ occupying bookings → 'booked', the rest → 'free'.
 */
export type SchedulePrimitives = {
  hours: Array<{ resource_id: string; weekday: number; start_time: string; end_time: string; effective_from: string | null; effective_to: string | null; timezone: string }>;
  breaks: Array<{ resource_id: string; weekday: number | null; on_date: string | null; start_time: string; end_time: string }>;
  overrides: Array<{ resource_id: string; on_date: string; kind: string; start_time: string | null; end_time: string | null; timezone: string }>;
  leave: Array<{ resource_id: string; start: number | null; end: number | null }>;
  blocks: Array<{ resource_id: string; start: number | null; end: number | null }>;
  booked: Array<{ resource_id: string; start: number; end: number }>;
};

const iv = (s: number | null, e: number | null): Interval => [s ?? -8.64e15, e ?? 8.64e15];
const t8 = (t: string) => t.slice(0, 8);

export function buildCapacityWindows(p: SchedulePrimitives, staffIds: string[], businessTz: string, from: string, to: string): CapacityWindow[] {
  const out: CapacityWindow[] = [];
  const days = dateRange(from, to);
  for (const id of staffIds) {
    const myHours = p.hours.filter((h) => h.resource_id === id);
    const tzBreaks = myHours[0]?.timezone ?? businessTz;
    const myLeave = merge(p.leave.filter((l) => l.resource_id === id).map((l) => iv(l.start, l.end)));
    const myBlocks = p.blocks.filter((l) => l.resource_id === id).map((l) => iv(l.start, l.end));
    const myBooked = merge(p.booked.filter((b) => b.resource_id === id).map((b) => [b.start, b.end] as Interval));
    for (const d of days) {
      const wd = weekdayOf(d);
      let base: Interval[] = myHours
        .filter((h) => h.weekday === wd && (!h.effective_from || h.effective_from <= d) && (!h.effective_to || h.effective_to >= d))
        .map((h) => [localToMs(d, t8(h.start_time), h.timezone), localToMs(d, t8(h.end_time), h.timezone)] as Interval);
      const ovs = p.overrides.filter((o) => o.resource_id === id && o.on_date === d);
      if (ovs.some((o) => o.kind === 'off')) base = [];
      else {
        const repl = ovs.filter((o) => o.kind === 'replace' && o.start_time && o.end_time);
        if (repl.length) base = repl.map((o) => [localToMs(d, t8(o.start_time!), o.timezone), localToMs(d, t8(o.end_time!), o.timezone)] as Interval);
        base.push(...ovs.filter((o) => o.kind === 'extra' && o.start_time && o.end_time).map((o) => [localToMs(d, t8(o.start_time!), o.timezone), localToMs(d, t8(o.end_time!), o.timezone)] as Interval));
      }
      base = merge(base);
      if (!base.length) continue;
      const br = p.breaks.filter((b) => b.resource_id === id && (b.on_date === d || (b.on_date === null && b.weekday === wd)))
        .map((b) => [localToMs(d, t8(b.start_time), tzBreaks), localToMs(d, t8(b.end_time), tzBreaks)] as Interval);
      const blocked = intersect(base, merge([...br, ...myBlocks]));
      const afterBlocks = subtract(base, blocked);
      const leave = intersect(afterBlocks, myLeave);
      const available = subtract(afterBlocks, leave);
      const booked = intersect(available, myBooked);
      const free = subtract(available, booked);
      for (const [s, e] of blocked) out.push({ resource_id: id, start: s, end: e, state: 'blocked' });
      for (const [s, e] of leave) out.push({ resource_id: id, start: s, end: e, state: 'leave' });
      for (const [s, e] of booked) out.push({ resource_id: id, start: s, end: e, state: 'booked' });
      for (const [s, e] of free) out.push({ resource_id: id, start: s, end: e, state: 'free' });
    }
  }
  return out.sort((a, b) => a.start - b.start || a.resource_id.localeCompare(b.resource_id));
}
