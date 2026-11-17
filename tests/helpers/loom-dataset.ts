import type { CanonicalDataset, CapacityWindow, CostFact, Customer, InventoryItem, Offering, OfferingRequirement, Transaction } from '@/loom';
import { buildCapacityWindows } from '@/loom/connectors/luma/capacity';
import { addDays, localToMs, localToday } from '@/loom/util/time';
import { beautyPack, computeMetrics, DEFAULT_RANKING_WEIGHTS, MetricContext, qualityGate, resolveProfile, runEngine, type ResolvedProfile, type ProfileFact } from '@/loom';

/**
 * Synthetic canonical datasets for pure engine tests (no database). Time is
 * fixed so results are deterministic.
 */
export const TZ = 'Asia/Riyadh';
export const NOW = new Date('2026-11-09T09:00:00Z');
export const TODAY = localToday(TZ, NOW);
const DAY = 86_400_000;
let seq = 0;
export const uid = (p = 'x') => `${p}-${(++seq).toString(16).padStart(4, '0')}-0000-4000-8000-000000000000`.slice(0, 36);

export type Builder = {
  ds: CanonicalDataset;
  service: (o: Omit<Partial<Offering>, 'name'> & { name?: string; cost?: number | null }) => Offering;
  product: (o: Omit<Partial<Offering>, 'name'> & { name?: string; cost?: number | null }) => Offering;
  staff: (opts?: { hours?: [string, string]; days?: number[]; qualified?: string[] }) => string;
  qualify: (staffId: string, offeringId: string) => void;
  customer: (o?: Partial<Customer>) => string;
  sale: (o: { offering: Offering; customer: string; daysAgo: number; staff?: string; net?: number; status?: Transaction['status']; discount?: number }) => void;
  book: (o: { offering: Offering; staff: string; customer: string; inDays: number; hour?: number; minutes?: number }) => void;
  recipe: (offeringId: string, item: InventoryItem, qty: number, unit?: string, approved?: boolean) => void;
  item: (o: Partial<InventoryItem> & { name: string }) => InventoryItem;
  review: (offeringId: string, rating: number, daysAgo?: number) => void;
  commission: (rateBp: number) => void;
  /** Rebuilds capacity windows (call after staff/bookings change). */
  finalize: () => CanonicalDataset;
};

export function datasetBuilder(opts: { createdDaysAgo?: number } = {}): Builder {
  const hours: Array<{ resource_id: string; weekday: number; start_time: string; end_time: string; effective_from: null; effective_to: null; timezone: string }> = [];
  const booked: Array<{ resource_id: string; start: number; end: number }> = [];
  const ds: CanonicalDataset = {
    business: { id: uid('b'), sector: 'beauty', subsector: 'salon', city: 'الرياض', timezone: TZ, currency: 'SAR', locale: 'ar', created_at: NOW.getTime() - (opts.createdDaysAgo ?? 400) * DAY },
    locations: [], offerings: [], requirements: [], inventory: [], resources: [], capacity: [], transactions: [], costs: [], demand: [], reviews: [], complaints: [],
    customers: [], campaigns: [], calendar: [], signals: [], host_preferences: null,
    meta: {
      connection_id: 'c', connector: 'test', as_of: NOW.getTime(), today: TODAY, lookback_from: addDays(TODAY, -90), horizon_to: addDays(TODAY, 13), past_capacity_from: addDays(TODAY, -28),
      data_version: 'v', entity_versions: {}, counts: {}, synced_at: {}, revenue_basis: 'net',
    },
  };
  const mk = (kind: 'service' | 'product', o: Omit<Partial<Offering>, 'name'> & { name?: string; cost?: number | null }): Offering => {
    const { name, cost: _cost, ...rest } = o;
    const off: Offering = {
      id: uid(kind === 'service' ? 's' : 'p'), kind, source_kind: kind, price_minor: 20000, status: 'active', category_id: null,
      duration_min: kind === 'service' ? 60 : null, buffer_min: 0, has_image: true, has_description: true, recorded_cost_minor: null, visible: true, product_id: null, location_id: null, ...rest,
      name: { ar: name ?? 'خدمة', en: name ?? 'Service' },
    };
    if (o.cost !== undefined) off.recorded_cost_minor = o.cost;
    ds.offerings.push(off);
    const fact: CostFact = off.recorded_cost_minor === null
      ? { type: 'material', scope: { kind: 'offering', offering_id: off.id }, amount_minor: null, rate_bp: null, basis: 'recorded_cost', completeness: 'missing' }
      : { type: 'material', scope: { kind: 'offering', offering_id: off.id }, amount_minor: off.recorded_cost_minor, rate_bp: null, basis: 'recorded_cost', completeness: 'complete' };
    ds.costs.push(fact);
    if (kind === 'service') ds.requirements.push({ offering_id: off.id, type: 'time', ref_id: null, quantity: off.duration_min ?? 60, unit: 'min', confidence: 'recipe' });
    return off;
  };
  const b: Builder = {
    ds,
    service: (o) => mk('service', o),
    product: (o) => mk('product', o),
    staff: (o = {}) => {
      const id = uid('st');
      ds.resources.push({ id, kind: 'staff', type_ref: null, location_id: null, active: true, skills: [] });
      for (const wd of o.days ?? [0, 1, 2, 3, 4, 5, 6]) hours.push({ resource_id: id, weekday: wd, start_time: o.hours?.[0] ?? '10:00', end_time: o.hours?.[1] ?? '18:00', effective_from: null, effective_to: null, timezone: TZ });
      for (const off of o.qualified ?? []) b.qualify(id, off);
      return id;
    },
    qualify: (staffId, offeringId) => {
      ds.requirements.push({ offering_id: offeringId, type: 'skill', ref_id: staffId, quantity: 60, unit: 'min', confidence: 'recipe' });
      ds.resources.find((r) => r.id === staffId)!.skills.push(offeringId);
    },
    customer: (o = {}) => {
      const c: Customer = { pseudo_id: uid('c'), created_at: NOW.getTime() - 300 * DAY, first_seen: null, last_seen: null, visits: 0, segments: [], acquisition_source: null, consents: {}, dup_key: null, ...o };
      ds.customers.push(c);
      return c.pseudo_id;
    },
    sale: (o) => {
      const at = NOW.getTime() - o.daysAgo * DAY;
      const net = o.net ?? o.offering.price_minor;
      const status = o.status ?? 'fulfilled';
      ds.transactions.push({
        id: uid('t'), kind: o.offering.kind === 'product' ? 'order' : 'booking', status, source_status: status, channel: 'direct', origin: null, customer_ref: o.customer,
        gross_minor: net + (o.discount ?? 0), discount_minor: o.discount ?? 0, tax_minor: 0, total_minor: net, refunded_minor: 0, net_minor: net, occurred_at: at, campaign_id: null, has_coupon: false, platform_fee_minor: 0,
        lines: [{ id: uid('l'), offering_id: o.offering.id, resource_ids: o.staff ? [o.staff] : [], qty: 1, net_minor: net, line_total_minor: net + (o.discount ?? 0), cost_direct_minor: null, starts_at: at, duration_min: o.offering.duration_min }],
        consistent: true,
      });
      const c = ds.customers.find((x) => x.pseudo_id === o.customer);
      if (c && status === 'fulfilled') { c.visits++; c.last_seen = Math.max(c.last_seen ?? 0, at); c.first_seen = Math.min(c.first_seen ?? at, at); }
      if (o.staff && status === 'fulfilled' && o.daysAgo <= 28) {
        const date = addDays(TODAY, -o.daysAgo);
        const s = localToMs(date, `${String(11).padStart(2, '0')}:00`, TZ);
        booked.push({ resource_id: o.staff, start: s, end: s + (o.offering.duration_min ?? 60) * 60_000 });
      }
    },
    book: (o) => {
      const date = addDays(TODAY, o.inDays);
      const s = localToMs(date, `${String(o.hour ?? 10).padStart(2, '0')}:00`, TZ);
      const minutes = o.minutes ?? o.offering.duration_min ?? 60;
      booked.push({ resource_id: o.staff, start: s, end: s + minutes * 60_000 });
      ds.transactions.push({
        id: uid('t'), kind: 'booking', status: 'confirmed', source_status: 'confirmed', channel: 'direct', origin: null, customer_ref: o.customer, gross_minor: o.offering.price_minor, discount_minor: 0,
        tax_minor: 0, total_minor: o.offering.price_minor, refunded_minor: 0, net_minor: o.offering.price_minor, occurred_at: s, campaign_id: null, has_coupon: false, platform_fee_minor: 0,
        lines: [{ id: uid('l'), offering_id: o.offering.id, resource_ids: [o.staff], qty: 1, net_minor: o.offering.price_minor, line_total_minor: o.offering.price_minor, cost_direct_minor: null, starts_at: s, duration_min: minutes }],
        consistent: true,
      });
    },
    item: (o) => {
      const it: InventoryItem = { id: uid('i'), usage: 'consumable', on_hand: 0, reserved: 0, unit: 'ml', unit_cost_minor: 10, reorder_level: null, offering_id: null, location_id: null, active: true, consumed_90d: 0, sold_90d: 0, ...o };
      ds.inventory.push(it);
      return it;
    },
    recipe: (offeringId, item, qty, unit = item.unit, approved = true) => {
      const r: OfferingRequirement = { offering_id: offeringId, type: 'material', ref_id: item.id, quantity: qty, unit, confidence: approved ? 'recipe' : 'estimated' };
      ds.requirements.push(r);
    },
    review: (offeringId, rating, daysAgo = 10) => { ds.reviews.push({ id: uid('r'), rating, offering_id: offeringId, resource_id: null, verified: true, at: NOW.getTime() - daysAgo * DAY }); },
    commission: (rateBp) => {
      ds.costs = ds.costs.filter((c) => c.type !== 'commission');
      ds.costs.push({ type: 'commission', scope: { kind: 'category', category: 'services' }, amount_minor: null, rate_bp: rateBp, basis: 'policy', completeness: 'complete' });
      ds.costs.push({ type: 'commission', scope: { kind: 'category', category: 'products' }, amount_minor: null, rate_bp: 0, basis: 'policy', completeness: 'complete' });
    },
    finalize: () => {
      const windows: CapacityWindow[] = buildCapacityWindows({ hours, breaks: [], overrides: [], leave: [], blocks: [], booked }, ds.resources.filter((r) => r.kind === 'staff').map((r) => r.id), TZ, addDays(TODAY, -28), addDays(TODAY, 13));
      ds.capacity = windows;
      return ds;
    },
  };
  b.commission(0);
  return b;
}

export function profileWith(facts: Array<{ key: string; value: unknown; kind?: ProfileFact['kind'] }> = [], goals: ResolvedProfile['goals'] = []): ResolvedProfile {
  const now = new Date().toISOString();
  return resolveProfile(facts.map((f, i) => ({
    id: `f${i}`, key: f.key, value: f.value, kind: f.kind ?? 'explicit', source: { type: 'user', ref: null }, confidence: null, needs_review: false, valid_from: now, updated_at: now, updated_by: null,
  })), goals, DEFAULT_RANKING_WEIGHTS);
}


/** Runs metrics → quality → engine on a synthetic dataset (the pure part of the analysis pipeline). */
export function analyzeDs(ds: CanonicalDataset, profile: ResolvedProfile = profileWith(), threshold = 0.8) {
  const ctx = new MetricContext(ds, { cost_completeness_threshold: threshold });
  const metrics = computeMetrics(ctx);
  const quality = qualityGate(ctx);
  const r = runEngine({ ds, ctx, metrics, quality, profile, pack: beautyPack, params: {} });
  return { ctx, metrics, quality, ...r };
}

/** A mature salon: staff A (10–18 daily) qualified for S1; 25 S1 sales over 90 days from 8 repeat customers. */
export function matureSalon(opts: { s1Cost?: number | null } = {}) {
  const b = datasetBuilder();
  const s1 = b.service({ name: 'Hair', price_minor: 20000, cost: opts.s1Cost === undefined ? 4000 : opts.s1Cost });
  const a = b.staff({ qualified: [s1.id] });
  const customers = Array.from({ length: 8 }, () => b.customer());
  for (let i = 0; i < 25; i++) b.sale({ offering: s1, customer: customers[i % 8]!, daysAgo: 3 + i * 3, staff: a });
  return { b, s1, a, customers };
}
