import type { CanonicalDataset, Offering, Transaction } from '../contracts/canonical';
import { unitEconomics, type SaleLine, type UnitEconomics } from '../economics/unit';
import { median } from '../util/text';
import { addDays, daypartOf, localDateOf, localHour, localToMs, weekdayOf, type Daypart } from '../util/time';

/**
 * Shared, lazily computed views of a dataset that metrics, the quality gate,
 * detectors and checks all read (computed once per analysis).
 */
export type Slot = { key: string; weekday: number; daypart: Daypart; available_min: number; booked_min: number; occupancy: number | null };
export type CoreSettings = { cost_completeness_threshold: number };

export class MetricContext {
  readonly tz: string;
  readonly today: string;
  readonly now: number;
  readonly lookbackStart: number;
  readonly todayStart: number;
  readonly horizonEnd: number;
  readonly past28Start: number;
  readonly d30Start: number;
  private cache = new Map<string, unknown>();

  constructor(readonly ds: CanonicalDataset, readonly settings: CoreSettings) {
    this.tz = ds.business.timezone;
    this.today = ds.meta.today;
    this.now = ds.meta.as_of;
    this.todayStart = localToMs(this.today, '00:00', this.tz);
    this.lookbackStart = localToMs(ds.meta.lookback_from, '00:00', this.tz);
    this.horizonEnd = localToMs(addDays(this.today, 14), '00:00', this.tz);
    this.past28Start = localToMs(addDays(this.today, -28), '00:00', this.tz);
    this.d30Start = localToMs(addDays(this.today, -30), '00:00', this.tz);
  }

  memo<T>(key: string, f: () => T): T {
    if (!this.cache.has(key)) this.cache.set(key, f());
    return this.cache.get(key) as T;
  }

  get offeringById() { return this.memo('offeringById', () => new Map(this.ds.offerings.map((o) => [o.id, o]))); }
  get activeServices(): Offering[] { return this.memo('activeServices', () => this.ds.offerings.filter((o) => o.kind === 'service' && o.status === 'active')); }
  get activeOfferings(): Offering[] { return this.memo('activeOfferings', () => this.ds.offerings.filter((o) => o.status === 'active')); }

  /** All transactions that happened in the 90-day lookback window (any status). */
  get tx90(): Transaction[] { return this.memo('tx90', () => this.ds.transactions.filter((t) => t.occurred_at >= this.lookbackStart && t.occurred_at < this.todayStart)); }
  get sales90(): Transaction[] { return this.memo('sales90', () => this.tx90.filter((t) => t.status === 'fulfilled' && t.consistent)); }
  get inconsistent90(): Transaction[] { return this.memo('inconsistent90', () => this.tx90.filter((t) => !t.consistent)); }

  get salesLinesByOffering(): Map<string, SaleLine[]> {
    return this.memo('slbo', () => {
      const m = new Map<string, SaleLine[]>();
      for (const tx of this.sales90) for (const line of tx.lines) { const a = m.get(line.offering_id) ?? []; a.push({ line, tx }); m.set(line.offering_id, a); }
      return m;
    });
  }

  economics(offeringId: string): UnitEconomics | null {
    return this.memo(`econ:${offeringId}`, () => {
      const o = this.offeringById.get(offeringId);
      return o ? unitEconomics(this.ds, o, this.salesLinesByOffering.get(offeringId) ?? []) : null;
    });
  }

  /** Revenue-weighted cost completeness over sold offerings (services and products). */
  get businessCostCompleteness(): { value: number | null; missing: Offering[] } {
    return this.memo('bcc', () => {
      let known = 0, total = 0;
      const missing: Offering[] = [];
      for (const o of this.ds.offerings.filter((x) => (x.kind === 'service' || x.kind === 'product') && x.status === 'active')) {
        const e = this.economics(o.id)!;
        const rev = (this.salesLinesByOffering.get(o.id) ?? []).reduce((m, s) => m + s.line.net_minor, 0);
        total += rev; known += rev * e.completeness;
        if (e.completeness < this.settings.cost_completeness_threshold && (o.kind === 'service' || e.sales_n > 0)) missing.push(o);
      }
      return { value: total > 0 ? known / total : null, missing };
    });
  }

  // ── Capacity ──
  private bucketize(states: Array<'free' | 'booked'>, from: number, to: number) {
    const out = new Map<string, number>();
    for (const w of this.ds.capacity) {
      if (!states.includes(w.state as 'free')) continue;
      let t = Math.max(w.start, from);
      const e = Math.min(w.end, to);
      while (t < e) {
        const next = Math.min(e, (Math.floor(t / 3_600_000) + 1) * 3_600_000);
        const date = localDateOf(t, this.tz);
        const key = `${weekdayOf(date)}.${daypartOf(localHour(t, this.tz))}`;
        out.set(key, (out.get(key) ?? 0) + (next - t) / 60_000);
        t = next;
      }
    }
    return out;
  }

  /** Weekday × daypart occupancy over the past 28 days (booked ÷ available). */
  get pastSlots(): Slot[] {
    return this.memo('pastSlots', () => this.slots(this.past28Start, this.todayStart));
  }
  /** The same slots over the next 14 days (already booked share and free minutes). */
  get nextSlots(): Slot[] {
    return this.memo('nextSlots', () => this.slots(this.todayStart, this.horizonEnd));
  }
  private slots(from: number, to: number): Slot[] {
    const avail = this.bucketize(['free', 'booked'], from, to);
    const booked = this.bucketize(['booked'], from, to);
    const out: Slot[] = [];
    for (let wd = 0; wd < 7; wd++) for (const dp of ['morning', 'afternoon', 'evening'] as const) {
      const key = `${wd}.${dp}`;
      const a = Math.round(avail.get(key) ?? 0), b = Math.round(booked.get(key) ?? 0);
      if (a > 0) out.push({ key, weekday: wd, daypart: dp, available_min: a, booked_min: b, occupancy: b / a });
    }
    return out;
  }

  minutes(states: Array<'free' | 'booked' | 'leave' | 'blocked'>, from: number, to: number, resourceIds?: Set<string>) {
    let m = 0;
    for (const w of this.ds.capacity) {
      if (!states.includes(w.state) || (resourceIds && !resourceIds.has(w.resource_id))) continue;
      const s = Math.max(w.start, from), e = Math.min(w.end, to);
      if (e > s) m += (e - s) / 60_000;
    }
    return Math.round(m);
  }

  /** Free minutes per local day over the next 14 days. */
  get nextDays(): Array<{ date: string; free_min: number; available_min: number }> {
    return this.memo('nextDays', () => {
      const out: Array<{ date: string; free_min: number; available_min: number }> = [];
      for (let i = 0; i < 14; i++) {
        const date = addDays(this.today, i);
        const s = localToMs(date, '00:00', this.tz), e = localToMs(addDays(date, 1), '00:00', this.tz);
        out.push({ date, free_min: this.minutes(['free'], s, e), available_min: this.minutes(['free', 'booked'], s, e) });
      }
      return out;
    });
  }

  /** Staff qualified for an offering (skill requirement), active only. */
  qualifiedResources(offeringId: string): string[] {
    return this.memo(`qual:${offeringId}`, () => {
      const active = new Set(this.ds.resources.filter((r) => r.active && r.kind === 'staff').map((r) => r.id));
      return [...new Set(this.ds.requirements.filter((r) => r.offering_id === offeringId && r.type === 'skill' && r.ref_id && active.has(r.ref_id)).map((r) => r.ref_id!))];
    });
  }

  // ── Demand ──
  demand30(type: string, offeringId?: string | null) {
    let c = 0;
    for (const d of this.ds.demand) if (d.type === type && d.day >= this.d30Start - 86_400_000 && d.day < this.todayStart + 86_400_000 && (offeringId === undefined || d.offering_id === offeringId)) c += d.count;
    return c;
  }
  sessions30(type = 'page_view') {
    let c = 0;
    for (const d of this.ds.demand) if (d.type === type && d.day >= this.d30Start) c += d.sessions;
    return c;
  }

  // ── Customers / cadence ──
  /** Per offering: median repeat gap (days, gaps ≥ 1), gap count, and pseudonymous customers past 1.5× without a future booking. */
  get cadence(): Map<string, { days: number | null; n: number; lapsed: string[] }> {
    return this.memo('cadence', () => {
      const visits = new Map<string, Map<string, number[]>>();
      const horizonStart = this.now - 730 * 86_400_000;
      for (const t of this.ds.transactions) {
        if (t.status !== 'fulfilled' || t.kind !== 'booking' || t.occurred_at < horizonStart) continue;
        for (const l of t.lines) {
          const m = visits.get(l.offering_id) ?? new Map<string, number[]>();
          const a = m.get(t.customer_ref) ?? []; a.push(l.starts_at); m.set(t.customer_ref, a); visits.set(l.offering_id, m);
        }
      }
      const future = new Set(this.ds.transactions.filter((t) => t.kind === 'booking' && t.occurred_at > this.now && (t.status === 'requested' || t.status === 'confirmed')).map((t) => t.customer_ref));
      const out = new Map<string, { days: number | null; n: number; lapsed: string[] }>();
      for (const [off, byC] of visits) {
        const gaps: number[] = [];
        for (const ts of byC.values()) { const s = [...ts].sort((a, b) => a - b); for (let i = 1; i < s.length; i++) { const g = (s[i]! - s[i - 1]!) / 86_400_000; if (g >= 1) gaps.push(g); } }
        const days = gaps.length >= 3 ? median(gaps) : null;
        const lapsed: string[] = [];
        if (days !== null) for (const [c, ts] of byC) if (Math.max(...ts) < this.now - days * 1.5 * 86_400_000 && !future.has(c)) lapsed.push(c);
        out.set(off, { days, n: gaps.length, lapsed: lapsed.sort() });
      }
      return out;
    });
  }

  get consentedCustomers(): number {
    return this.memo('consented', () => this.ds.customers.filter((c) => Object.values(c.consents).some(Boolean)).length);
  }
}
