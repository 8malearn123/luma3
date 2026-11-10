import { timingContextFor } from '../radar/timing';
import { DateTime } from 'luxon';
import { sql, withSystem, withTenant, type Tx } from '../db';
import { ensureConnection } from '../analysis/run';
import { connectorFor } from '../connectors/registry';
import type { CanonicalDataset } from '../contracts/canonical';
import type { CardContent, InventoryStatus, OpportunityCategory } from '../contracts/opportunity';
import type { HighlightedOffering, PlanKind } from '../contracts/plan';
import { loadDataset } from '../dataset';
import { snippet, type RetrievedUnit } from '../knowledge/library';
import { retrieveKnowledge } from '../knowledge/store';
import { MetricContext } from '../metrics/context';
import { metricDefinition } from '../metrics/registry';
import '../metrics/v1';
import { loadFacts, loadGoals, resolveProfile, type ResolvedProfile } from '../profile/facts';
import { sectorPack } from '../sector/beauty';
import type { SectorPack } from '../sector/types';
import { readPlatformSettings } from '../settings/platform';
import { stableHash, type Localized } from '../util/text';
import { addDays, localToMs } from '../util/time';
import { convertQty } from '../util/units';
import { PROMOTIONAL_KINDS } from '../validator/validate';

/**
 * Everything the planner (AI or rules) needs, loaded once per run and scoped
 * to ONE business: the selected opportunities with their evidence and checks,
 * the profile, the canonical dataset (slots, materials, verified events),
 * the latest metric values and the retrieved knowledge.
 */
export type PlanOpp = {
  ref: string;
  id: string;
  status: string;
  category: OpportunityCategory;
  detector_id: string;
  bucket: string | null;
  card: CardContent;
  offering_id: string | null;
  offering_ids: string[];
  promotional: boolean;
  evidence: Array<{ id: string; metric_key: string; label: Localized; value: number | null; n: number | null }>;
  /** Computed facts the text may cite (cf_<ref>_<name>). */
  computed: Array<{ id: string; label: string; value: number }>;
  knowledge: RetrievedUnit[];
  /** Free bookable slots in the plan window for the offering (null = not slot-based / no schedule). */
  free_slots: number | null;
  highlighted: HighlightedOffering | null;
};

export type PlanningContext = {
  businessId: string;
  kind: PlanKind;
  period: { from: string; to: string };
  today: string;
  locale: 'ar' | 'en';
  analysis: { id: string; snapshot_hash: string | null; mode: string | null };
  profile: ResolvedProfile;
  pack: SectorPack;
  ds: CanonicalDataset;
  ctx: MetricContext;
  opps: PlanOpp[];
  metrics: Map<string, number | null>;
  events: Array<{ ref: string; title: string; starts_on: string; ends_on: string; awareness_only?: boolean }>;
  candidates_hash: string;
};

export const BASELINE_METRICS = ['sales.completed_count', 'sales.completed_net', 'customers.active_90d', 'customers.repeat_rate', 'capacity.occupancy_next14', 'quality.rating_avg'] as const;

/** Selected opportunities: decided ones first (accepted / converted), then open ones by rank; blocked ones become prerequisites. */
const SELECTABLE = ['accepted', 'converted', 'proposed', 'studying'];

export function periodFor(kind: PlanKind, today: string, periodStart?: string | null): { from: string; to: string } {
  if (kind === 'weekly') { const from = periodStart ?? today; return { from, to: addDays(from, 6) }; }
  const d = DateTime.fromISO(periodStart ?? today, { zone: 'UTC' });
  return { from: d.startOf('month').toISODate()!, to: d.endOf('month').toISODate()! };
}

/** Bookable slots for qualified staff in [from, to] (business-local dates), with up to 5 sample starts. */
export function freeSlots(ctx: MetricContext, offeringId: string, from: string, to: string): { count: number | null; samples: string[] } {
  const o = ctx.offeringById.get(offeringId);
  if (!o || o.kind !== 'service') return { count: null, samples: [] };
  const ids = new Set(ctx.qualifiedResources(offeringId));
  if (!ids.size) return { count: 0, samples: [] };
  const start = Math.max(localToMs(from, '00:00', ctx.tz), ctx.now), end = Math.min(localToMs(addDays(to, 1), '00:00', ctx.tz), ctx.horizonEnd);
  const scheduled = ctx.minutes(['free', 'booked', 'leave', 'blocked'], start, end, ids);
  if (end <= start || scheduled === 0) return { count: null, samples: [] };
  const need = ((o.duration_min ?? 60) + o.buffer_min) * 60_000;
  let count = 0;
  const samples: string[] = [];
  for (const w of [...ctx.ds.capacity].sort((a, b) => a.start - b.start)) {
    if (w.state !== 'free' || !ids.has(w.resource_id)) continue;
    const s = Math.max(w.start, start), e = Math.min(w.end, end);
    for (let t = s; t + need <= e; t += need) {
      count++;
      if (samples.length < 5) samples.push(DateTime.fromMillis(t, { zone: ctx.tz }).toFormat('yyyy-LL-dd HH:mm'));
    }
  }
  return { count, samples };
}

/** Materials an offering consumes per service (approved recipe only) and what is on hand. */
export function materialsOf(ctx: MetricContext, offeringId: string): { materials: HighlightedOffering['materials']; status: InventoryStatus } {
  const recipe = ctx.ds.requirements.filter((r) => r.offering_id === offeringId && r.type === 'material');
  if (!recipe.length) return { materials: [], status: 'no_recipe' };
  const out: HighlightedOffering['materials'] = [];
  for (const r of recipe) {
    const it = ctx.ds.inventory.find((i) => i.id === r.ref_id);
    const per = it ? convertQty(r.quantity, r.unit, it.unit) : null;
    if (!it || per === null || r.confidence !== 'recipe') return { materials: [], status: 'no_recipe' };
    out.push({ name: it.name, per_service: per, unit: it.unit, available: Math.max(0, it.on_hand - it.reserved) });
  }
  const covers = Math.min(...out.map((m) => Math.floor(m.available / m.per_service + 1e-9)));
  return { materials: out, status: covers > 0 ? 'ok' : 'reorder_needed' };
}

function computedFacts(ref: string, c: CardContent, freeSlotsN: number | null) {
  const f: PlanOpp['computed'] = [];
  const add = (name: string, label: string, v: number | null | undefined) => { if (v !== null && v !== undefined && Number.isFinite(v)) f.push({ id: `cf_${ref.toLowerCase()}_${name}`, label, value: v }); };
  add('capacity_max', 'bookable slots for qualified staff (14 days, after reservations)', c.capacity_check.max_additional);
  add('covers', 'services the stock covers', c.inventory_check.covers_n);
  add('segment', 'customers in the target segment', c.target_segment.size_status === 'counted' ? c.target_segment.size : null);
  add('discount_pct', 'discount percent within the cap', c.recommended_action.discount_bp ? c.recommended_action.discount_bp / 100 : null);
  add('breakeven', 'volume increase needed to offset the discount (ratio)', c.margin_check.breakeven_volume_increase);
  add('margin_before', 'unit margin before (minor units)', c.margin_check.unit_margin_before_minor);
  add('cost', 'estimated cost (minor units)', c.estimated_cost.amount_minor);
  add('free_slots', 'free slots for the offering in the plan window', freeSlotsN);
  for (const m of c.success_metrics) add(`baseline_${m.metric_key.replace(/[^a-z0-9]/g, '_')}`, `baseline of ${m.metric_key}`, m.baseline);
  return f;
}

export async function loadPlanningContext(businessId: string, opts: { kind: PlanKind; periodStart?: string | null; now?: Date; k?: number; opportunityIds?: string[] }): Promise<PlanningContext | { insufficient: string }> {
  const platform = await withSystem('loom: platform settings for planner', (trx) => readPlatformSettings(trx));
  const conn = await withTenant(businessId, (trx) => ensureConnection(trx, businessId));
  const ds = await loadDataset(connectorFor(conn.kind), { ...conn, as_of: opts.now });
  const ctx = new MetricContext(ds, { cost_completeness_threshold: platform.cost_completeness_threshold });
  const pack = sectorPack(ds.business.sector);
  const today = ds.meta.today;
  const period = periodFor(opts.kind, today, opts.periodStart);

  return withTenant(businessId, async (trx) => {
    const analysis = await trx.selectFrom('loom.analyses').select(['id', 'snapshot_hash', 'mode']).where('business_id', '=', businessId).where('status', '=', 'succeeded')
      .orderBy('finished_at', 'desc').executeTakeFirst();
    if (!analysis) return { insufficient: 'no_analysis' };
    const profile = resolveProfile(await loadFacts(trx, businessId), await loadGoals(trx, businessId), platform.default_ranking_weights);
    let qb = trx.selectFrom('loom.opportunities').selectAll().where('business_id', '=', businessId).where('status', 'in', SELECTABLE);
    if (opts.opportunityIds?.length) qb = qb.where('id', 'in', opts.opportunityIds);
    const rows = await qb.orderBy(sqlDecidedFirst()).orderBy('priority_rank', 'asc').execute();
    const k = opts.k ?? (opts.kind === 'monthly' ? 6 : 5);
    const chosen = rows.slice(0, k);
    if (!chosen.length) return { insufficient: 'no_opportunities' };
    const metrics = await latestMetrics(trx, businessId, analysis.id);
    const opps: PlanOpp[] = [];
    for (const [i, r] of chosen.entries()) {
      const ref = `O${i + 1}`;
      const card = r.card as CardContent;
      const subject = r.subject as { offering_ids: string[]; reserve?: { offering_id: string | null } };
      const offeringId = subject.reserve?.offering_id ?? subject.offering_ids[0] ?? null;
      const promotional = r.category !== 'capacity_prerequisite' && PROMOTIONAL_KINDS.has(card.recommended_action.kind);
      const slots = offeringId && promotional ? freeSlots(ctx, offeringId, period.from, period.to) : { count: null, samples: [] };
      const mats = offeringId ? materialsOf(ctx, offeringId) : null;
      const off = offeringId ? ctx.offeringById.get(offeringId) : undefined;
      const ev = card.evidence_refs.length ? await trx.selectFrom('loom.opportunity_evidence').select(['id', 'metric_key', 'label', 'value', 'n']).where('business_id', '=', businessId).where('id', 'in', card.evidence_refs).execute() : [];
      const knowledge = await retrieveKnowledge(trx, { sector: pack.id, detector: r.detector_id, intervention: card.recommended_action.intervention_id, channels: card.channel, text: `${card.title.en} ${card.recommended_action.description.en}`, limit: 2 }, today);
      opps.push({
        ref, id: r.id, status: r.status, category: r.category as OpportunityCategory, detector_id: r.detector_id, bucket: r.display_bucket, card, offering_id: offeringId,
        offering_ids: subject.offering_ids, promotional,
        evidence: ev.map((e) => ({ id: e.id, metric_key: e.metric_key, label: e.label as Localized, value: e.value, n: e.n })),
        computed: computedFacts(ref, card, slots.count), knowledge, free_slots: slots.count,
        highlighted: off && off.kind === 'service' && promotional ? { offering_id: off.id, name: off.name, free_slots: slots.count, sample_slots: slots.samples, materials: mats?.materials ?? [], materials_status: mats?.status ?? 'not_applicable' } : null,
      });
    }
    const horizon = addDays(period.to, 30);
    const events: PlanningContext['events'] = ds.calendar.filter((e) => e.verified && e.ends_on >= period.from && e.starts_on <= horizon).map((e) => ({ ref: `calendar:${e.id}`, title: e.title, starts_on: e.starts_on, ends_on: e.ends_on }));
    // Phase 4 radar: verified platform events adopted for (or attached to) the chosen opportunities. Unverified dates never reach the planner (T8).
    for (const o of opps) {
      const tc = await timingContextFor(businessId, { id: o.id, period }, { now: opts.now });
      for (const e of tc.events) {
        if (e.origin !== 'platform_calendar' || !e.usable_for_dates || events.some((x) => x.ref === e.ref)) continue;
        events.push({ ref: e.ref, // Imported titles are untrusted external text: only the curated ones reach the model prompt.
          title: e.title_is_untrusted ? e.kind : ds.business.locale === 'en' ? e.title.en : e.title.ar, starts_on: e.starts_on, ends_on: e.ends_on, awareness_only: e.framing === 'awareness_only' });
      }
    }
    const candidates_hash = stableHash({
      kind: opts.kind, period, opps: opps.map((o) => ({ id: o.id, card: o.card, status: o.status, free: o.free_slots, k: o.knowledge.map((x) => `${x.unit.id}@${x.unit.version}`) })),
      prefs: profile.prefs, goals: profile.goals.map((g) => g.kind), events,
    });
    return { businessId, kind: opts.kind, period, today, locale: ds.business.locale, analysis, profile, pack, ds, ctx, opps, metrics, events, candidates_hash };
  });
}

const sqlDecidedFirst = () => sql`case when status in ('accepted', 'converted') then 0 else 1 end`;

async function latestMetrics(trx: Tx, businessId: string, analysisId: string) {
  const rows = await trx.selectFrom('loom.metric_values').select(['metric_key', 'grain_ref', 'value']).where('business_id', '=', businessId).where('analysis_id', '=', analysisId).execute();
  return new Map(rows.map((r) => [`${r.metric_key}|${r.grain_ref}`, r.value]));
}

/** Business-level baseline from the latest analysis. */
export function baselineOf(pc: Pick<PlanningContext, 'metrics'>) {
  return BASELINE_METRICS.map((k) => ({ metric_key: k, label: metricDefinition(k)?.label ?? { ar: k, en: k }, value: pc.metrics.get(`${k}|business`) ?? null }));
}

/** The compact, redacted input given to the model (no names, phones, ids of customers). */
export function plannerInput(pc: PlanningContext) {
  const excludedNames = pc.ds.offerings.filter((o) => pc.profile.prefs.excluded_offerings.includes(o.id)).map((o) => o.name);
  return {
    task: pc.kind === 'monthly' ? 'monthly_plan' : 'weekly_plan',
    locale: pc.locale,
    period: pc.period,
    business: {
      sector: pc.pack.id,
      goals: pc.profile.goals.map((g) => ({ kind: g.kind, priority: g.priority })),
      tone: pc.profile.prefs.tone,
      no_discounts: pc.profile.prefs.no_discounts,
      max_discount_pct: pc.profile.prefs.max_discount_bp / 100,
      monthly_budget_minor: pc.profile.prefs.monthly_budget_minor,
      excluded_offerings: excludedNames,
      currency: pc.ds.business.currency,
    },
    opportunities: pc.opps.map((o) => ({
      ref: o.ref, category: o.category, promotional: o.promotional,
      draft: { title: o.card.title, why_now: o.card.why_now, action: { kind: o.card.recommended_action.kind, description: o.card.recommended_action.description } },
      checks: { capacity: o.card.capacity_check.status, inventory: o.card.inventory_check.status, margin: o.card.margin_check.status },
      channels: o.card.channel, window: o.card.period, prerequisites: o.card.prerequisites,
      evidence: o.evidence.map((e) => ({ id: e.id, metric: e.metric_key, label: e.label, value: e.value, n: e.n })),
      computed: o.computed,
      free_slots_in_period: o.free_slots,
      knowledge: o.knowledge.map((k) => snippet(k.unit)),
    })),
    verified_events: pc.events,
  };
}
