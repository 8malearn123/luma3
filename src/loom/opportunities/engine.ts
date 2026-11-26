import { checkCapacity, checkInventory, checkMargin, type CapacityResult, type InventoryResult, type MarginResult } from '../checks';
import type { CardContent, Channel, EvidenceStrength, OpportunityCategory } from '../contracts/opportunity';
import { DETECTORS } from '../detectors/v1';
import type { DetectContext, Detector, EvidenceItem, OpportunityCandidate } from '../detectors/types';
import { selectIntervention, type Selection } from '../interventions/selector';
import type { QualityDomain } from '../metrics/registry';
import { SETUP_ITEMS } from '../profile/facts';
import { meets } from '../quality/gate';
import { evidenceStrength, rank, type RankInput } from '../ranking/rank';
import { L, type Localized } from '../util/text';
import { addDays, monthKey } from '../util/time';

/**
 * Opportunity engine (§6.1 steps detect → checks → intervention → rank).
 * Pure: takes a DetectContext, returns fully assessed opportunities (cards
 * without evidence ids — those are minted when persisted) plus what was
 * suppressed and why.
 */
export type AssessedOpportunity = {
  fingerprint: string;
  detector_id: string;
  category: OpportunityCategory;
  subject: OpportunityCandidate['subject'] & { key: string };
  card: Omit<CardContent, 'evidence_refs'>;
  evidence: EvidenceItem[];
  checks: { capacity: CapacityResult; inventory: InventoryResult; margin: MarginResult; preferences: { status: 'ok' | 'adjusted'; notes: Localized[] } };
  evidence_strength: EvidenceStrength;
  evidence_reasons: Localized[];
  /** Volume this opportunity would reserve on its offering if accepted (conflict accounting). */
  reserve: { offering_id: string | null; volume: number | null };
  promotional: boolean;
};

export type EngineResult = { opportunities: AssessedOpportunity[]; suppressed: Array<{ detector_id: string; subject_key?: string; reason: string }> };

const DOMAIN_OF: Record<OpportunityCategory, QualityDomain> = {
  quiet_capacity: 'capacity', high_satisfaction_low_demand: 'reviews', lapsed_cohort: 'customers', unserved_demand: 'demand', conversion_friction: 'demand',
  cross_sell_affinity: 'sales', slow_mover_bundle: 'inventory', margin_leak: 'economics', missing_cost_blocker: 'economics', offering_presentation: 'demand',
  loyalty_over_discount: 'sales', capacity_prerequisite: 'capacity', campaign_learning: 'campaigns',
  stockout_risk: 'inventory',
};
const MARGIN_DEPENDENT: OpportunityCategory[] = ['margin_leak', 'slow_mover_bundle', 'cross_sell_affinity'];
const ONGOING: OpportunityCategory[] = ['missing_cost_blocker', 'margin_leak', 'conversion_friction', 'offering_presentation', 'campaign_learning', 'loyalty_over_discount'];

export function fingerprintOf(detectorId: string, subjectKey: string, today: string) {
  return `${detectorId}:${subjectKey}:${monthKey(today)}`;
}

export function runEngine(dc: DetectContext, opts: { reserved?: Map<string, number>; detectors?: Detector[] } = {}): EngineResult {
  const suppressed: EngineResult['suppressed'] = [];
  const reserved = opts.reserved ?? new Map<string, number>();
  const pack = dc.pack;
  const candidates: OpportunityCandidate[] = [];

  for (const det of opts.detectors ?? DETECTORS) {
    const cfg = pack.detectors.find((d) => d.id === det.id);
    if (!cfg) continue;
    if (!det.sectors.includes('*') && !det.sectors.includes(pack.id)) continue;
    if (dc.quality.exploratory && det.needsSegmentation) { suppressed.push({ detector_id: det.id, reason: 'exploratory_no_segmentation' }); continue; }
    const unmet = Object.entries(det.minQuality).filter(([d, need]) => !meets(dc.quality.domains[d as QualityDomain].level, need!));
    if (unmet.length) { suppressed.push({ detector_id: det.id, reason: `quality:${unmet.map(([d]) => d).join(',')}` }); continue; }
    for (const c of det.detect({ ...dc, params: cfg.params })) candidates.push(c);
  }

  const excluded = new Set(dc.profile.prefs.excluded_offerings);
  const out: AssessedOpportunity[] = [];
  const rankInputs: Array<RankInput & { idx: number }> = [];

  for (const c0 of candidates) {
    if (c0.promotional && c0.subject.offering_ids.some((id) => excluded.has(id))) {
      suppressed.push({ detector_id: c0.detector_id, subject_key: c0.subject_key, reason: 'excluded_offering' });
      continue;
    }
    let c = c0;
    const capacity = checkCapacity(dc.ctx, c.check_offering_id, c.target_volume, c.check_offering_id ? reserved.get(c.check_offering_id) ?? 0 : 0);
    const inventory = checkInventory(dc.ctx, c.check_offering_id, c.target_volume);
    const prereqs: Localized[] = [...c.prerequisites];
    let category: OpportunityCategory = c.category;
    // Blocked by staff time or by materials ⇒ shown as a prerequisite before any campaign (§6.6).
    const blockedByCapacity = c.promotional && capacity.status === 'blocked' && !c.meta.no_prerequisite_conversion;
    const blockedByMaterials = c.promotional && inventory.status === 'reorder_needed' && inventory.covers_n === 0;
    if (blockedByCapacity || blockedByMaterials) category = 'capacity_prerequisite';
    if (inventory.status === 'reorder_needed') for (const r of inventory.reorder) prereqs.push(L(`إعادة طلب ${r.name}: المطلوب ${r.needed} ${r.unit} والمتاح ${r.available}`, `Reorder ${r.name}: ${r.needed} ${r.unit} needed, ${r.available} available`));
    if (capacity.status === 'constrained') prereqs.push(L(`الترويج بحد أقصى ${capacity.max_additional} موعدًا متاحًا`, `Promote at most ${capacity.max_additional} available slots`));
    if (category === 'capacity_prerequisite') {
      c = { ...c, title: L(`متطلب قبل الحملة: ${c.title.ar}`, `Prerequisite before the campaign: ${c.title.en}`) };
      if (blockedByCapacity) prereqs.push(L('إضافة وردية أو أخصائية مؤهلة في نافذة الحملة', 'Add a shift or a qualified specialist in the campaign window'));
    }

    // Intervention (preferences are hard constraints inside the selector).
    let sel: Selection = selectIntervention(c, dc, category === 'capacity_prerequisite' ? 'capacity_prerequisite' : c.category);
    if (category === 'capacity_prerequisite' && !blockedByCapacity && sel.chosen?.id === 'add_shift') {
      const restock = dc.pack.catalog.restock;
      sel = { chosen: { ...restock, discount_bp: null, direction: null, rationale: null }, alternatives: [{ kind: 'staffing', intervention_id: 'add_shift', rejected_because: L('القيد هو المواد وليس الطاقة', 'The constraint is materials, not staff time') }] };
    }
    if (!sel.chosen) {
      suppressed.push({ detector_id: c.detector_id, subject_key: c.subject_key, reason: 'no_viable_intervention' });
      continue;
    }
    const chosen = sel.chosen;
    const margin = checkMargin(dc.ctx, c.check_offering_id ?? null, { discount_bp: chosen.discount_bp, baseline_volume: c.baseline_volume });
    const econ = c.check_offering_id ? dc.ctx.economics(c.check_offering_id) : null;

    const prefNotes: Localized[] = [];
    if (dc.profile.prefs.no_discounts) prefNotes.push(L('لا خصومات حسب إعداداتك؛ استُبعدت خيارات الخصم.', 'No discounts per your settings; discount options were removed.'));
    else if (chosen.discount_bp) prefNotes.push(L(`الخصم ${chosen.discount_bp / 100}% ضمن سقفك (${dc.profile.prefs.max_discount_bp / 100}%).`, `The ${chosen.discount_bp / 100}% discount is within your cap (${dc.profile.prefs.max_discount_bp / 100}%).`));

    const costsComplete = margin.status !== 'costs_incomplete';
    const strength = evidenceStrength({
      n: c.sample.n, min: c.sample.min, domainOk: dc.quality.domains[DOMAIN_OF[c.category]].level === 'ok',
      costsNeeded: MARGIN_DEPENDENT.includes(c.category) || !!chosen.discount_bp, costsComplete, exploratory: dc.quality.exploratory,
    });

    const channels = (chosen.channels.filter((ch) => c.channels.includes(ch)).length ? chosen.channels.filter((ch) => c.channels.includes(ch)) : chosen.channels) as Channel[];
    const unitMargin = margin.unit_margin_after_minor ?? margin.unit_margin_before_minor;
    const impact = costsComplete && unitMargin !== null && c.target_volume ? Math.max(0, Math.round(c.target_volume * unitMargin * 0.5)) : null;
    const estimated = chosen.discount_bp && econ && c.target_volume
      ? { amount_minor: Math.round((econ.price_minor * chosen.discount_bp * c.target_volume) / 10_000), basis: 'computed' as const }
      : chosen.cash_cost === 'none' ? { amount_minor: 0, basis: 'computed' as const } : { amount_minor: null, basis: 'unknown' as const };

    const assumptions: Localized[] = [...c.assumptions];
    if (chosen.rationale) assumptions.push(chosen.rationale);
    if (dc.profile.prefs.weights_source === 'platform_default') assumptions.push(L('رُتبت الفرص بالأوزان الافتراضية للمنصة.', 'Opportunities are ranked with the platform default weights.'));
    const limitations: Localized[] = [...c.limitations];
    if (econ && margin.status !== 'not_applicable') limitations.push(L('رسوم معالجة الدفع غير مسجلة ولم تُطرح من الهامش.', 'Payment processing fees are not recorded and are not deducted from the margin.'));
    if (dc.quality.exploratory) limitations.push(L('تحليل استكشافي: البيانات أقل من ٣٠ يومًا أو ٢٠ عملية؛ تجارب محدودة فقط ودون تقسيمات دقيقة.', 'Exploratory analysis: less than 30 days or 20 sales of data; limited trials only and no fine segments.'));
    if (!dc.profile.setup.complete) {
      const names = SETUP_ITEMS.filter((s) => dc.profile.setup.missing.includes(s.id)).map((s) => s.label);
      limitations.push(L(`إعدادات مطلوبة غير مؤكدة: ${names.map((n) => n.ar).join('، ')}.`, `Required settings not confirmed: ${names.map((n) => n.en).join(', ')}.`));
    }
    if (margin.status === 'costs_incomplete') limitations.push(margin.note);

    const card: Omit<CardContent, 'evidence_refs'> = {
      category,
      title: c.title,
      period: c.window,
      why_now: c.why_now,
      hypotheses: c.hypotheses.map((text) => ({ text, status: 'hypothesis' as const })),
      recommended_action: { kind: chosen.kind, description: chosen.description, intervention_id: chosen.id, discount_bp: chosen.discount_bp, direction: chosen.direction },
      alternatives_considered: sel.alternatives,
      target_segment: dc.quality.exploratory && c.segment.size_status === 'counted' && c.promotional
        ? { ...c.segment, size_status: c.segment.size !== null && c.segment.size >= 30 ? 'counted' : 'insufficient' } : c.segment,
      channel: channels,
      timing: { window: L(`${c.window.from} ← ${c.window.to}`, `${c.window.from} → ${c.window.to}`), event_ref: null },
      estimated_cost: estimated,
      capacity_check: { status: capacity.status, max_additional: capacity.max_additional, note: capacity.note },
      inventory_check: { status: inventory.status, covers_n: inventory.covers_n, note: inventory.note },
      margin_check: { status: margin.status, unit_margin_before_minor: margin.unit_margin_before_minor, unit_margin_after_minor: margin.unit_margin_after_minor, breakeven_volume_increase: margin.breakeven_volume_increase, note: margin.note },
      prerequisites: prereqs,
      draft_content: null,
      success_metrics: (c.success_metrics.length ? c.success_metrics : [{ metric_key: 'sales.completed_count', baseline: null, target: null }]).map((m) => ({ ...m, target_kind: 'proposed_goal' as const })),
      measurement_design: dc.quality.exploratory && c.measurement_design === 'holdout' ? 'observational' : c.measurement_design,
      assumptions,
      limitations,
      data_quality: dc.quality.domains[DOMAIN_OF[c.category]].level === 'insufficient' ? 'insufficient' : dc.quality.overall,
      priority: { rank: 0, explanation: L('', ''), score: 0, factors: {}, evidence_strength: strength.strength, bucket: 'study' },
      knowledge_refs: [],
      review_at: addDays(dc.ctx.today, 14),
    };

    rankInputs.push({
      idx: out.length, key: fingerprintOf(c.detector_id, c.subject_key, dc.ctx.today), goal_kinds: c.goal_kinds, offering_ids: c.subject.offering_ids, evidence_strength: strength.strength,
      impact_minor: impact, capacity: c.check_offering_id ? capacity.status : 'not_needed', inventory: inventory.status, prerequisites: prereqs.length,
      effort_hours: chosen.effort_hours, cash_cost: chosen.cash_cost, timing: ONGOING.includes(c.category) ? 0.5 : 1,
      conflict: !!(c.check_offering_id && (reserved.get(c.check_offering_id) ?? 0) > 0),
      quality_risk: c.promotional && ((dc.metrics.value('quality.no_show_rate') ?? 0) > 0.15 || (dc.metrics.value('quality.cancel_customer_rate') ?? 0) > 0.2),
      blocked: category === 'capacity_prerequisite',
    });
    out.push({
      fingerprint: fingerprintOf(c.detector_id, c.subject_key, dc.ctx.today), detector_id: c.detector_id, category, subject: { ...c.subject, key: c.subject_key },
      card, evidence: c.evidence, checks: { capacity, inventory, margin, preferences: { status: prefNotes.length ? 'adjusted' : 'ok', notes: prefNotes } },
      evidence_strength: strength.strength, evidence_reasons: strength.reasons, reserve: { offering_id: c.check_offering_id, volume: c.target_volume }, promotional: c.promotional,
    });
  }

  attachSeasonalTiming(dc, out);

  for (const r of rank(rankInputs, dc.profile.prefs.ranking_weights, dc.profile)) {
    const o = out[r.idx]!;
    o.card.priority = { rank: r.rank, explanation: r.explanation, score: r.score, factors: r.factors, evidence_strength: o.evidence_strength, bucket: r.bucket };
  }
  out.sort((a, b) => a.card.priority.rank - b.card.priority.rank);
  return { opportunities: out, suppressed };
}

/**
 * P1: a documented event only sets timing for an EXISTING internal
 * opportunity; an event alone never creates one (T8). Market signals are not
 * attached here (stale ones are reported as stale in the analysis result, T7).
 */
export function attachSeasonalTiming(dc: DetectContext, opps: AssessedOpportunity[]) {
  const horizon = addDays(dc.ctx.today, 45);
  const events = dc.ds.calendar.filter((e) => e.verified && e.starts_on >= dc.ctx.today && e.starts_on <= horizon).sort((a, b) => a.starts_on.localeCompare(b.starts_on));
  for (const o of opps) {
    if (!o.promotional || o.category === 'capacity_prerequisite') continue;
    const ev = events.find((e) => e.starts_on <= addDays(o.card.period.to, 30));
    if (!ev) continue;
    o.card.timing = { window: L(`${o.card.timing.window.ar} — قبل «${ev.title}» (${ev.starts_on})`, `${o.card.timing.window.en} — ahead of “${ev.title}” (${ev.starts_on})`), event_ref: `calendar:${ev.id}` };
  }
}
