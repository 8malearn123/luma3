import { DateTime } from 'luxon';

/**
 * Availability engine (pure). All I/O happens in loader.ts; this module only
 * computes feasible itineraries from a snapshot of schedules and allocations,
 * so the algorithm is deterministic and exhaustively testable.
 *
 * Algorithm (spec §17):
 *  1. Validate services/branch (loader).
 *  2. Item duration = variant/staff override/service duration + add-ons; buffers before/after.
 *  3. Qualified staff per item; required resource types per item.
 *  4. Free time per staff = working hours (weekly ∩ effective dates, ± date overrides,
 *     ∩ branch opening hours when defined) − breaks − approved leave − time blocks −
 *     active allocations (confirmed + unexpired holds).
 *  5. Timezone-correct (branch tz), minimum notice, booking window, slot increment.
 *  6. Only feasible options are returned; nothing about other appointments leaks.
 *  7. "Any available": candidates ranked by the declared rule (see rankStaff).
 *  8. Results are advisory: holds re-validate inside the allocating transaction.
 * Multi-service: items are placed in order; each next item starts within
 * [previous end, previous end + maxGap] (aligned to the increment); different
 * staff per item allowed; search is bounded.
 */

export type Range = { start: number; end: number }; // epoch ms, half-open [start, end)

export type StaffSchedule = {
  staffId: string;
  sort: number;
  /** weekday (0=Sun) → local ranges "HH:MM" */
  weekly: Array<{ weekday: number; start: string; end: string; effectiveFrom: string | null; effectiveTo: string | null }>;
  breaks: Array<{ weekday: number | null; onDate: string | null; start: string; end: string }>;
  overrides: Array<{ onDate: string; kind: 'off' | 'replace' | 'extra'; start: string | null; end: string | null }>;
  /** Instants that are unavailable: leave, blocks, allocations. */
  busy: Range[];
};

export type ResourceSchedule = { resourceId: string; typeId: string; busy: Range[] };

export type ItemSpec = {
  key: string; // client correlation key
  serviceId: string;
  durationByStaff: Record<string, number>; // minutes incl. add-ons, per qualified staff
  bufferBefore: number;
  bufferAfter: number;
  qualifiedStaff: string[]; // already filtered by preference
  resourceNeeds: Array<{ typeId: string; quantity: number }>;
};

export type EngineInput = {
  tz: string;
  now: number;
  minNoticeMin: number;
  maxAdvanceDays: number;
  slotIncrementMin: number;
  maxGapMin: number;
  anyStaffRule: 'earliest_then_least_booked' | 'earliest_then_staff_order';
  branchHours: Array<{ weekday: number; opens: string; closes: string }>;
  staff: Record<string, StaffSchedule>;
  resources: ResourceSchedule[];
  /** Booked minutes per staff per local date (for least-booked tie-breaks). */
  bookedMinutes: Record<string, Record<string, number>>;
};

export type PlannedItem = { key: string; serviceId: string; staffId: string; start: number; end: number; occupied: Range; resourceIds: string[] };
export type Itinerary = { start: number; end: number; items: PlannedItem[]; gapsMin: number[]; totalGapMin: number };

const MIN = 60_000;

function hm(s: string) {
  const [h, m] = s.split(':').map(Number) as [number, number];
  return h * 60 + m;
}

function localRange(date: DateTime, start: string, end: string): Range {
  const s = date.startOf('day').plus({ minutes: hm(start) });
  const e = date.startOf('day').plus({ minutes: hm(end) });
  return { start: s.toMillis(), end: e.toMillis() };
}

export function subtract(base: Range[], cut: Range[]): Range[] {
  let out = base.map((r) => ({ ...r }));
  for (const c of cut) {
    const next: Range[] = [];
    for (const r of out) {
      if (c.end <= r.start || c.start >= r.end) { next.push(r); continue; }
      if (c.start > r.start) next.push({ start: r.start, end: c.start });
      if (c.end < r.end) next.push({ start: c.end, end: r.end });
    }
    out = next;
  }
  return out.filter((r) => r.end > r.start);
}

export function intersect(a: Range[], b: Range[]): Range[] {
  const out: Range[] = [];
  for (const x of a) for (const y of b) {
    const s = Math.max(x.start, y.start), e = Math.min(x.end, y.end);
    if (e > s) out.push({ start: s, end: e });
  }
  return merge(out);
}

export function merge(rs: Range[]): Range[] {
  const sorted = [...rs].sort((a, b) => a.start - b.start);
  const out: Range[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

const contains = (free: Range[], r: Range) => free.some((f) => f.start <= r.start && f.end >= r.end);

/** Working windows of one staff member for one local date (before subtracting busy time). */
export function workingWindows(input: EngineInput, s: StaffSchedule, dateISO: string): Range[] {
  const date = DateTime.fromISO(dateISO, { zone: input.tz });
  const weekday = date.weekday % 7; // luxon: Mon=1..Sun=7 → Sun=0
  const ov = s.overrides.filter((o) => o.onDate === dateISO);
  let windows: Range[];
  if (ov.some((o) => o.kind === 'off')) windows = [];
  else if (ov.some((o) => o.kind === 'replace')) windows = ov.filter((o) => o.kind === 'replace').map((o) => localRange(date, o.start!, o.end!));
  else {
    windows = s.weekly
      .filter((w) => w.weekday === weekday && (!w.effectiveFrom || w.effectiveFrom <= dateISO) && (!w.effectiveTo || w.effectiveTo >= dateISO))
      .map((w) => localRange(date, w.start, w.end));
  }
  if (!ov.some((o) => o.kind === 'off')) windows.push(...ov.filter((o) => o.kind === 'extra').map((o) => localRange(date, o.start!, o.end!)));
  windows = merge(windows);
  if (input.branchHours.length) {
    const bh = input.branchHours.filter((b) => b.weekday === weekday).map((b) => localRange(date, b.opens, b.closes));
    windows = intersect(windows, bh);
  }
  const breaks = s.breaks
    .filter((b) => (b.onDate ? b.onDate === dateISO : b.weekday === weekday))
    .map((b) => localRange(date, b.start, b.end));
  return subtract(windows, breaks);
}

export function freeWindows(input: EngineInput, s: StaffSchedule, dateISO: string): Range[] {
  return subtract(workingWindows(input, s, dateISO), s.busy);
}

function bookingBounds(input: EngineInput) {
  const earliest = input.now + input.minNoticeMin * MIN;
  const latestDay = DateTime.fromMillis(input.now, { zone: input.tz }).startOf('day').plus({ days: input.maxAdvanceDays }).endOf('day').toMillis();
  return { earliest, latestDay };
}

function alignUp(t: number, dayStart: number, incMin: number) {
  const inc = incMin * MIN;
  const off = (t - dayStart) % inc;
  return off === 0 ? t : t + (inc - off);
}

/**
 * Declared allocation rule for "any available specialist" (never random):
 *  - earliest_then_least_booked: among staff free at the same start, the one with
 *    the fewest booked minutes that day, then staff display order, then id.
 *  - earliest_then_staff_order: staff display order, then id.
 */
export function rankStaff(input: EngineInput, staffIds: string[], dateISO: string): string[] {
  return [...staffIds].sort((a, b) => {
    if (input.anyStaffRule === 'earliest_then_least_booked') {
      const ma = input.bookedMinutes[a]?.[dateISO] ?? 0, mb = input.bookedMinutes[b]?.[dateISO] ?? 0;
      if (ma !== mb) return ma - mb;
    }
    const sa = input.staff[a]?.sort ?? 0, sb = input.staff[b]?.sort ?? 0;
    return sa !== sb ? sa - sb : a.localeCompare(b);
  });
}

function pickResources(input: EngineInput, needs: ItemSpec['resourceNeeds'], occ: Range, taken: Map<string, Range[]>): string[] | null {
  const chosen: string[] = [];
  for (const need of needs) {
    const pool = input.resources
      .filter((r) => r.typeId === need.typeId)
      .filter((r) => !chosen.includes(r.resourceId))
      .filter((r) => ![...r.busy, ...(taken.get(r.resourceId) ?? [])].some((b) => b.start < occ.end && b.end > occ.start))
      .sort((a, b) => a.resourceId.localeCompare(b.resourceId));
    if (pool.length < need.quantity) return null;
    chosen.push(...pool.slice(0, need.quantity).map((r) => r.resourceId));
  }
  return chosen;
}

export type SearchLimits = { maxItinerariesPerDay: number; maxNodes: number };

/**
 * Feasible itineraries for one local date. For single-service requests this
 * yields one itinerary per feasible start time (best staff by the rule).
 */
export function itinerariesForDate(input: EngineInput, items: ItemSpec[], dateISO: string, limits: SearchLimits = { maxItinerariesPerDay: 200, maxNodes: 20_000 }): Itinerary[] {
  if (!items.length) return [];
  const { earliest, latestDay } = bookingBounds(input);
  const day = DateTime.fromISO(dateISO, { zone: input.tz }).startOf('day');
  const dayStart = day.toMillis();
  if (dayStart > latestDay) return [];

  const free: Record<string, Range[]> = {};
  const allStaff = new Set(items.flatMap((i) => i.qualifiedStaff));
  for (const id of allStaff) {
    const s = input.staff[id];
    if (s) free[id] = freeWindows(input, s, dateISO);
  }

  const results: Itinerary[] = [];
  const seenStarts = new Set<number>();
  let nodes = 0;
  const first = items[0]!;
  const firstCandidates = rankStaff(input, first.qualifiedStaff.filter((s) => free[s]?.length), dateISO);

  // Candidate first-item starts: aligned times inside any qualified staff's free windows.
  const starts = new Set<number>();
  for (const sid of firstCandidates) {
    for (const w of free[sid] ?? []) {
      for (let t = alignUp(w.start + first.bufferBefore * MIN, dayStart, input.slotIncrementMin); t < w.end; t += input.slotIncrementMin * MIN) starts.add(t);
    }
  }
  const sortedStarts = [...starts].filter((t) => t >= earliest).sort((a, b) => a - b);

  const place = (idx: number, minStart: number, maxStart: number, acc: PlannedItem[], taken: Map<string, Range[]>): PlannedItem[] | null => {
    if (idx === items.length) return acc;
    const it = items[idx]!;
    const cands = rankStaff(input, it.qualifiedStaff.filter((s) => free[s]?.length), dateISO);
    for (let t = alignUp(minStart, dayStart, input.slotIncrementMin); t <= maxStart; t += input.slotIncrementMin * MIN) {
      for (const sid of cands) {
        if (++nodes > limits.maxNodes) return null;
        const dur = it.durationByStaff[sid];
        if (!dur) continue;
        const end = t + dur * MIN;
        const occ = { start: t - it.bufferBefore * MIN, end: end + it.bufferAfter * MIN };
        const staffTaken = taken.get(`staff:${sid}`) ?? [];
        if (!contains(free[sid]!, occ) || staffTaken.some((b) => b.start < occ.end && b.end > occ.start)) continue;
        const res = pickResources(input, it.resourceNeeds, occ, taken);
        if (!res) continue;
        const nextTaken = new Map(taken);
        nextTaken.set(`staff:${sid}`, [...staffTaken, occ]);
        for (const r of res) nextTaken.set(r, [...(taken.get(r) ?? []), occ]);
        const planned: PlannedItem = { key: it.key, serviceId: it.serviceId, staffId: sid, start: t, end, occupied: occ, resourceIds: res };
        const rest = place(idx + 1, end, end + input.maxGapMin * MIN, [...acc, planned], nextTaken);
        if (rest) return rest;
      }
      if (idx === 0) break; // first item start is fixed by the outer loop
    }
    return null;
  };

  for (const t0 of sortedStarts) {
    if (results.length >= limits.maxItinerariesPerDay || nodes > limits.maxNodes) break;
    if (seenStarts.has(t0)) continue;
    const plan = place(0, t0, t0, [], new Map());
    if (!plan) continue;
    seenStarts.add(t0);
    const gaps = plan.slice(1).map((p, i) => Math.round((p.start - plan[i]!.end) / MIN));
    results.push({ start: plan[0]!.start, end: plan[plan.length - 1]!.end, items: plan, gapsMin: gaps, totalGapMin: gaps.reduce((a, b) => a + b, 0) });
  }
  return results;
}

/** Itineraries across a date range (local dates, inclusive), capped to 31 days. */
export function itinerariesForRange(input: EngineInput, items: ItemSpec[], fromISO: string, toISO: string) {
  const out: Record<string, Itinerary[]> = {};
  let d = DateTime.fromISO(fromISO, { zone: input.tz });
  const end = DateTime.fromISO(toISO, { zone: input.tz });
  for (let i = 0; i <= 31 && d <= end; i++, d = d.plus({ days: 1 })) {
    const iso = d.toISODate()!;
    out[iso] = itinerariesForDate(input, items, iso);
  }
  return out;
}

/**
 * Validates one concrete itinerary (used when creating a hold): every item must
 * be placeable exactly at its requested start with its requested staff.
 */
export function validateItinerary(input: EngineInput, items: ItemSpec[], requested: Array<{ key: string; staffId: string; start: number }>): { ok: true; plan: PlannedItem[] } | { ok: false; reason: string; key?: string } {
  const { earliest, latestDay } = bookingBounds(input);
  const taken = new Map<string, Range[]>();
  const plan: PlannedItem[] = [];
  let prevEnd: number | null = null;
  for (const it of items) {
    const req = requested.find((r) => r.key === it.key);
    if (!req) return { ok: false, reason: 'missing_item', key: it.key };
    if (!it.qualifiedStaff.includes(req.staffId)) return { ok: false, reason: 'staff_not_qualified', key: it.key };
    if (req.start < earliest) return { ok: false, reason: 'notice_period', key: it.key };
    if (req.start > latestDay) return { ok: false, reason: 'beyond_booking_window', key: it.key };
    if (prevEnd !== null && (req.start < prevEnd || req.start > prevEnd + input.maxGapMin * MIN)) return { ok: false, reason: 'invalid_sequence', key: it.key };
    const s = input.staff[req.staffId];
    const dur = it.durationByStaff[req.staffId];
    if (!s || !dur) return { ok: false, reason: 'staff_not_qualified', key: it.key };
    const dateISO = DateTime.fromMillis(req.start, { zone: input.tz }).toISODate()!;
    const end = req.start + dur * MIN;
    const occ = { start: req.start - it.bufferBefore * MIN, end: end + it.bufferAfter * MIN };
    const free = freeWindows(input, s, dateISO);
    const staffTaken = taken.get(`staff:${req.staffId}`) ?? [];
    if (!contains(free, occ) || staffTaken.some((b) => b.start < occ.end && b.end > occ.start)) return { ok: false, reason: 'slot_unavailable', key: it.key };
    const res = pickResources(input, it.resourceNeeds, occ, taken);
    if (!res) return { ok: false, reason: 'resource_unavailable', key: it.key };
    taken.set(`staff:${req.staffId}`, [...staffTaken, occ]);
    for (const r of res) taken.set(r, [...(taken.get(r) ?? []), occ]);
    plan.push({ key: it.key, serviceId: it.serviceId, staffId: req.staffId, start: req.start, end, occupied: occ, resourceIds: res });
    prevEnd = end;
  }
  return { ok: true, plan };
}

/** Available working minutes for occupancy (after breaks/leave/blocks, before bookings). */
export function availableMinutes(input: EngineInput, s: StaffSchedule, dateISO: string, nonBookingBusy: Range[]) {
  return subtract(workingWindows(input, s, dateISO), nonBookingBusy).reduce((a, r) => a + (r.end - r.start) / MIN, 0);
}

export function rangeOverlaps(a: Range, b: Range) {
  return a.start < b.end && a.end > b.start;
}

