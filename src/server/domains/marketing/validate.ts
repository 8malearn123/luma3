import type { PlanContent } from '@/shared/schemas/marketing';
import type { AiPlan, AiRecommendation } from './prompts';
import type { SnapshotData, SnapshotService } from './snapshot';
import type { MarginCheck, RecDraft } from './types';

/**
 * Validation of model output against the trusted snapshot (§29 step 5):
 *  - citations: evidence_refs must be snapshot metric keys (or trend refs);
 *  - numbers: every measured metric must match the snapshot; numbers in the
 *    claim text must trace to a cited metric, otherwise they are labelled
 *    unsupported (and too many → rejected); unsupported forecasts are dropped;
 *  - constraints: max discount, no promotion of full slots, capacity, margins
 *    (missing costs ⇒ costs_incomplete and no profitability assertion),
 *    seasonal dates only from the verified calendar.
 */

const PROFIT_RE = /profitab|profit margin|high[- ]margin|مربح|ربحي|ربحية عالية/i;
const DATE_RE = /\b\d{4}-\d{2}-\d{2}\b/g;
const NUM_RE = /\d+(?:[.,]\d+)?/g;
const PROMO = new Set(['quiet_periods', 'service_promotion', 'reactivation', 'seasonal', 'trend']);

export function normalizeDigits(s: string) {
  return s.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))).replace(/٫/g, '.');
}

/** Values a cited metric may legitimately appear as in prose. */
function allowedForms(v: number | null, unit: string): number[] {
  if (v === null) return [];
  const out = [v, Math.round(v), Math.round(v * 10) / 10, Math.round(v * 100) / 100];
  if (unit === 'ratio') out.push(Math.round(v * 100), Math.round(v * 1000) / 10);
  if (unit === 'minor') out.push(v / 100, Math.round(v / 100));
  if (unit === 'minutes') out.push(Math.round(v / 60), Math.round((v / 60) * 10) / 10);
  return out;
}

export function unsupportedNumbers(text: string | null | undefined, allowed: number[]): number[] {
  if (!text) return [];
  const t = normalizeDigits(text).replace(DATE_RE, ' ');
  const nums = (t.match(NUM_RE) ?? []).map((n) => Number(n.replace(',', '.'))).filter((n) => Number.isFinite(n));
  return nums.filter((n) => !allowed.some((a) => Math.abs(a - n) <= Math.max(0.01, Math.abs(a) * 0.01)));
}

export function marginFor(svcs: SnapshotService[], discountBp: number | null): MarginCheck {
  if (!svcs.length) return { status: 'not_applicable', discount_bp: discountBp };
  const missing = svcs.filter((s) => s.cost_status === 'missing').map((s) => s.ref);
  if (missing.length) return { status: 'costs_incomplete', services_missing_costs: missing, discount_bp: discountBp, note: 'Profitability cannot be assessed until costs are recorded.' };
  const min = Math.min(...svcs.map((s) => s.margin_ratio ?? 0));
  const after = discountBp ? min - discountBp / 10000 : min;
  return { status: after < 0.2 ? 'low_margin' : 'ok', min_margin_ratio: Math.round(min * 1000) / 1000, discount_bp: discountBp };
}

export type RecValidation = { accepted: RecDraft[]; rejected: Array<{ title: string; category: string; reasons: string[] }> };

export function validateRecommendations(d: SnapshotData, recs: AiRecommendation[], meta: { periodFrom: string; periodTo: string }): RecValidation {
  const accepted: RecDraft[] = [];
  const rejected: RecValidation['rejected'] = [];
  const free14 = d.metrics['capacity.next14.free_min']?.value ?? 0;
  const calendarDates = new Set(d.calendar.events.flatMap((e) => [e.starts_on, e.ends_on]));
  for (const r of recs) {
    const reasons: string[] = [];
    const flags: string[] = [];
    const evidence = r.evidence_refs.filter((k) => k in d.metrics);
    const unknownRefs = r.evidence_refs.filter((k) => !(k in d.metrics));
    if (unknownRefs.length) flags.push('unknown_evidence_refs_removed');
    if (!evidence.length) reasons.push('no_valid_evidence');

    const measured: RecDraft['measured_metrics'] = {};
    for (const m of r.measured_metrics) {
      const snap = d.metrics[m.key];
      if (!snap) { flags.push('unknown_metric_removed'); continue; }
      const ok = m.value === null ? snap.value === null : snap.value !== null && Math.abs(snap.value - m.value) <= Math.max(0.0001, Math.abs(snap.value) * 0.01);
      measured[m.key] = { value: snap.value, supported: ok, ...(ok ? {} : { claimed: m.value }) };
      if (!ok) flags.push('measured_value_mismatch');
    }
    for (const k of evidence) if (!measured[k]) measured[k] = { value: d.metrics[k]!.value, supported: true };

    const allowed = Object.keys(measured).flatMap((k) => allowedForms(d.metrics[k]?.value ?? null, d.metrics[k]?.unit ?? 'count'));
    if (r.discount_bp) allowed.push(r.discount_bp / 100, r.discount_bp);
    const badOpp = unsupportedNumbers(r.opportunity, allowed);
    if (badOpp.length > 2) reasons.push('unsupported_numeric_claims');
    else if (badOpp.length) flags.push('unsupported_numbers_labelled');
    let forecast = r.forecast;
    const badForecast = unsupportedNumbers(forecast, allowed);
    if (forecast && badForecast.length) { forecast = null; flags.push('unsupported_forecast_removed'); }

    if (r.discount_bp !== null && r.discount_bp > d.preferences.max_discount_bp) reasons.push('discount_exceeds_limit');
    const svcs = r.service_refs.map((ref) => d.services.find((s) => s.ref === ref)).filter((s): s is SnapshotService => !!s);
    const margin = marginFor(svcs, r.discount_bp);
    const assertsProfit = r.claims_profitable || PROFIT_RE.test(`${r.opportunity} ${r.suggested_action} ${r.draft_text ?? ''}`);
    if (assertsProfit && margin.status !== 'ok') reasons.push('unsupported_profitability_claim');
    if (r.discount_bp && margin.status === 'ok' && (margin.min_margin_ratio ?? 0) - r.discount_bp / 10000 < 0) reasons.push('discount_below_cost');

    const fullCited = evidence.filter((k) => k.startsWith('bucket.') && (d.metrics[k]?.value ?? 0) >= 0.85);
    if (PROMO.has(r.category) && fullCited.length) reasons.push('promotes_full_slots');
    if (PROMO.has(r.category) && free14 <= 0) reasons.push('no_free_capacity');
    const textDates = `${r.opportunity} ${r.suggested_action} ${r.timing}`.match(DATE_RE) ?? [];
    if (r.category === 'seasonal' && d.calendar.source === 'none') reasons.push('unverified_dates');
    if (textDates.some((t) => !calendarDates.has(t) && (t < meta.periodFrom || t > meta.periodTo))) flags.push('dates_outside_period');
    let confidence = r.confidence;
    if (r.category === 'trend') {
      const trendRefs = evidence.filter((k) => k.startsWith('trend.'));
      if (!trendRefs.length) reasons.push('trend_without_observation');
      const strengths = trendRefs.map((k) => d.trends.find((t) => `trend.${t.ref}` === k)).filter(Boolean).map((t) => t!.evidence_strength);
      if (!strengths.includes('quantified')) confidence = 'low';
    }
    if (flags.includes('unsupported_numbers_labelled') || flags.includes('measured_value_mismatch')) confidence = 'low';

    if (reasons.length) { rejected.push({ title: r.title, category: r.category, reasons }); continue; }
    accepted.push({
      title: r.title, category: r.category, horizon: r.horizon,
      period_start: r.horizon === 'ongoing' ? null : meta.periodFrom, period_end: r.horizon === 'ongoing' ? null : meta.periodTo,
      evidence_refs: evidence, measured_metrics: measured,
      opportunity: r.opportunity, suggested_action: r.suggested_action, timing: r.timing,
      estimated_cost: r.estimated_cost,
      capacity_check: PROMO.has(r.category) ? { status: free14 > 0 ? 'ok' : 'insufficient_capacity', free_min_next14: free14 } : { status: 'not_applicable' },
      margin_check: margin,
      draft_content: { text: r.draft_text, service_ids: svcs.map((s) => s.id) },
      channel: r.channel, prerequisites: r.prerequisites, success_metric: r.success_metric, experiment_design: r.experiment_design,
      confidence, limitations: r.limitations, proposed_target: r.proposed_target, forecast,
      fingerprint: `${r.category}:${svcs.map((s) => s.id).sort().join(',') || evidence.slice().sort().join(',')}:${r.title.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 80)}`,
      service_ids: svcs.map((s) => s.id),
      validation: { status: flags.length ? 'flagged' : 'passed', flags, unsupported_numbers: badOpp, removed_refs: unknownRefs },
    });
  }
  return { accepted, rejected };
}

/** Builds plan content from model output, with baselines and budget from trusted data only. */
export function validatePlan(d: SnapshotData, p: AiPlan, meta: { from: string; to: string; parentGoals?: Array<{ id: string; title: string }> }): { content: PlanContent; title: string; validation: Record<string, unknown> } {
  const flags: string[] = [];
  const goalIds = new Set((meta.parentGoals ?? []).map((g) => g.id));
  const freeByDay = new Map(d.capacity.next_days.map((x) => [x.date, x.free_min]));
  const initiatives = p.initiatives.map((i) => {
    const refs = i.evidence_refs.filter((k) => k in d.metrics);
    if (refs.length !== i.evidence_refs.length) flags.push('initiative_refs_removed');
    return { id: i.id, title: i.title, description: i.description, evidence_refs: refs };
  });
  const initIds = new Set(initiatives.map((i) => i.id));
  const inPeriod = (x: string | null) => (x && /^\d{4}-\d{2}-\d{2}$/.test(x) && x >= meta.from && x <= meta.to ? x : null);
  const activities = p.activities.map((a) => {
    const from = inPeriod(a.date_from), to = inPeriod(a.date_to);
    if ((a.date_from && !from) || (a.date_to && !to)) flags.push('activity_dates_outside_period');
    const free = from ? freeByDay.get(from) : undefined;
    const capacity_note = free !== undefined && free < 60 ? 'insufficient_capacity_on_date' : null;
    if (capacity_note) flags.push('activity_on_full_day');
    const ref = a.monthly_goal_ref && goalIds.has(a.monthly_goal_ref) ? a.monthly_goal_ref : null;
    if (a.monthly_goal_ref && !ref) flags.push('unknown_monthly_goal_ref');
    return {
      id: a.id, title: a.title, initiative_id: a.initiative_id && initIds.has(a.initiative_id) ? a.initiative_id : null,
      date_from: from, date_to: to && from && to < from ? from : to, channel: a.channel, content_idea: a.content_idea,
      owner: d.business.locale === 'ar' ? 'المالكة' : 'Owner', capacity_note, monthly_goal_ref: ref, status: 'planned' as const,
    };
  });
  const allValues = Object.values(d.metrics).flatMap((m) => allowedForms(m.value, m.unit));
  const goalNums = unsupportedNumbers(p.goal, allValues);
  if (goalNums.length) flags.push('goal_numbers_unsupported');
  const metrics = p.metrics.map((m) => {
    const snap = d.metrics[m.key];
    if (!snap) flags.push('metric_without_baseline');
    return { key: m.key, label: m.label, baseline: snap?.value ?? null, proposed_target: m.proposed_target };
  });
  const budget = d.preferences.monthly_budget_minor;
  return {
    title: p.title,
    content: {
      goal: p.goal,
      baseline: metrics.filter((m) => m.baseline !== null).map((m) => ({ metric_key: m.key, label: d.metrics[m.key]?.label ?? m.label, value: m.baseline })),
      initiatives, activities,
      dates: { start: meta.from, end: meta.to },
      owner: d.business.locale === 'ar' ? 'المالكة' : 'Owner',
      budget: budget === null ? { amount_minor: null, status: 'no_budget_set', assumptions: '' } : { amount_minor: budget, status: 'unknown', assumptions: 'Per-activity costs not estimated.' },
      metrics, monthly_goals: meta.parentGoals ?? initiatives.map((i) => ({ id: i.id, title: i.title })),
      experimental: d.sufficiency.level !== 'ok',
      limitations: p.limitations,
    },
    validation: { status: flags.length ? 'flagged' : 'passed', flags: [...new Set(flags)], unsupported_goal_numbers: goalNums },
  };
}

/** Rejects development text that strays into employment decisions. */
export const EMPLOYMENT_DECISION_RE = /dismiss|terminat|\bfire[sd]?\b|firing|lay ?off|salary|pay ?cut|wage|bonus|demot|disciplin|warning letter|فصل|إنهاء (?:الخدمة|العقد)|الاستغناء|راتب|رواتب|أجر|خصم من|عقوبة|إنذار|تأديب/i;
