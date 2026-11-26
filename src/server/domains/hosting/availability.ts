import { DateTime } from 'luxon';
import { sql } from 'kysely';
import type { Tx } from '../../db/client';
import { intersect, merge, subtract, type Range } from '../booking/engine';

/**
 * Availability of a listed space (D1b). Runs in system scope (it reads the host
 * salon's allocations); callers expose only free windows to a guest.
 *
 *   free = listing windows ∩ branch working hours
 *          − chair allocations (internal bookings, linked-staff bookings, other space bookings; confirmed + unexpired holds)
 *          − allocations of staff linked to the chair (busy while they have bookings)
 *          − time blocks on the chair (maintenance / manual)
 * A request needs [start − setup buffer, end + cleanup buffer] inside one free window.
 * The exclusion constraints on booking_allocations remain the final authority.
 */
export type ListingForAvailability = {
  id: string; tenant_id: string; branch_id: string; resource_id: string; setup_buffer_min: number; cleanup_buffer_min: number;
};
export type BusyBlock = Range & { kind: 'internal' | 'freelancer' | 'linked_staff' | 'blocked' | 'equipment' };

const MIN = 60_000;

function hm(t: string) {
  const [h, m] = t.split(':').map(Number) as [number, number];
  return h * 60 + m;
}

export async function branchTimezone(trx: Tx, tenantId: string, branchId: string) {
  return (await trx.selectFrom('branches').select('timezone').where('tenant_id', '=', tenantId).where('id', '=', branchId).executeTakeFirstOrThrow()).timezone;
}

/** Offered windows of one local date: listing windows ∩ branch hours (when the branch defines hours). */
export async function offeredWindows(trx: Tx, l: ListingForAvailability, dateISO: string, tz: string): Promise<Range[]> {
  const day = DateTime.fromISO(dateISO, { zone: tz }).startOf('day');
  const weekday = day.weekday % 7;
  const at = (t: string) => day.plus({ minutes: hm(t.slice(0, 5)) }).toMillis();
  const windows = await trx.selectFrom('workspace_listing_windows').select(['start_time', 'end_time']).where('tenant_id', '=', l.tenant_id).where('listing_id', '=', l.id).where('weekday', '=', weekday).execute();
  let out = merge(windows.map((w) => ({ start: at(w.start_time), end: at(w.end_time) })));
  const hours = await trx.selectFrom('branch_hours').select(['weekday', 'opens', 'closes']).where('tenant_id', '=', l.tenant_id).where('branch_id', '=', l.branch_id).execute();
  if (hours.length) out = intersect(out, hours.filter((h) => h.weekday === weekday).map((h) => ({ start: at(h.opens), end: at(h.closes) })));
  return out;
}

/** Everything that occupies the chair (and optionally extra resources) in a range. */
export async function busyBlocks(trx: Tx, l: ListingForAvailability, from: Date, to: Date, opts: { now?: Date; resourceIds?: string[]; exceptWorkspaceBookingId?: string } = {}): Promise<BusyBlock[]> {
  const now = opts.now ?? new Date();
  const window = sql`tstzrange(${from}, ${to})`;
  const resourceIds = [l.resource_id, ...(opts.resourceIds ?? [])];
  const links = await trx.selectFrom('resource_staff_links').select('staff_id').where('tenant_id', '=', l.tenant_id).where('resource_id', '=', l.resource_id).execute();
  const staffIds = links.map((x) => x.staff_id);
  const allocs = await trx.selectFrom('booking_allocations')
    .select(['resource_id', 'staff_id', 'workspace_booking_id', sql<Date>`lower(during)`.as('s'), sql<Date>`upper(during)`.as('e')])
    .where('tenant_id', '=', l.tenant_id).where(sql<boolean>`during && ${window}`)
    .where((eb) => eb.or([eb('resource_id', 'in', resourceIds), ...(staffIds.length ? [eb('staff_id', 'in', staffIds)] : [])]))
    .where((eb) => eb.or([eb('state', '=', 'confirmed'), eb.and([eb('state', '=', 'held'), eb('expires_at', '>', now)])]))
    .$if(!!opts.exceptWorkspaceBookingId, (q) => q.where((eb) => eb.or([eb('workspace_booking_id', 'is', null), eb('workspace_booking_id', '<>', opts.exceptWorkspaceBookingId!)])))
    .execute();
  const blocks = await trx.selectFrom('time_blocks').select(['resource_id', sql<Date>`lower(during)`.as('s'), sql<Date>`upper(during)`.as('e')])
    .where('tenant_id', '=', l.tenant_id).where('resource_id', 'in', resourceIds).where(sql<boolean>`during && ${window}`).execute();
  const kindOf = (resourceId: string | null, staffId: string | null, ws: string | null): BusyBlock['kind'] => {
    if (staffId) return 'linked_staff';
    if (resourceId !== l.resource_id) return 'equipment';
    return ws ? 'freelancer' : 'internal';
  };
  return [
    ...allocs.map((a) => ({ start: a.s.getTime(), end: a.e.getTime(), kind: kindOf(a.resource_id, a.staff_id, a.workspace_booking_id) })),
    ...blocks.map((b) => ({ start: b.s.getTime(), end: b.e.getTime(), kind: (b.resource_id === l.resource_id ? 'blocked' : 'equipment') as BusyBlock['kind'] })),
  ];
}

/** Free windows of the chair on a local date (busy time already removed). */
export async function freeWindows(trx: Tx, l: ListingForAvailability, dateISO: string, opts: { now?: Date; exceptWorkspaceBookingId?: string } = {}) {
  const tz = await branchTimezone(trx, l.tenant_id, l.branch_id);
  const offered = await offeredWindows(trx, l, dateISO, tz);
  if (!offered.length) return { tz, offered, free: [] as Range[], busy: [] as BusyBlock[] };
  const from = new Date(Math.min(...offered.map((o) => o.start))), to = new Date(Math.max(...offered.map((o) => o.end)));
  const busy = (await busyBlocks(trx, l, from, to, opts)).filter((b) => b.kind !== 'equipment');
  return { tz, offered, free: subtract(offered, busy), busy };
}

/** Occupied chair range for a request (with setup/cleanup buffers). */
export function occupiedFor(l: Pick<ListingForAvailability, 'setup_buffer_min' | 'cleanup_buffer_min'>, start: Date, end: Date): Range {
  return { start: start.getTime() - l.setup_buffer_min * MIN, end: end.getTime() + l.cleanup_buffer_min * MIN };
}

export const fits = (free: Range[], r: Range) => free.some((f) => f.start <= r.start && f.end >= r.end);

/**
 * Advisory check for one request: the chair window must be free, and every
 * extra resource (included / rented equipment) must be free for the occupied range.
 */
export async function requestFits(trx: Tx, l: ListingForAvailability, start: Date, end: Date, extraResourceIds: string[], now = new Date()) {
  const occ = occupiedFor(l, start, end);
  const tz = await branchTimezone(trx, l.tenant_id, l.branch_id);
  const dates = new Set([DateTime.fromMillis(occ.start, { zone: tz }).toISODate()!, DateTime.fromMillis(occ.end - 1, { zone: tz }).toISODate()!]);
  let free: Range[] = [];
  for (const d of dates) free = merge([...free, ...(await freeWindows(trx, l, d, { now })).free]);
  if (!fits(free, occ)) return { ok: false as const, reason: 'slot_unavailable' };
  if (extraResourceIds.length) {
    const busy = await busyBlocks(trx, l, new Date(occ.start), new Date(occ.end), { now, resourceIds: extraResourceIds });
    if (busy.some((b) => b.kind === 'equipment' && b.start < occ.end && b.end > occ.start)) return { ok: false as const, reason: 'equipment_unavailable' };
  }
  return { ok: true as const, occ, tz };
}
