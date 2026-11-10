import { describe, expect, it } from 'vitest';
import {
  aggregateBusiness, assertNoLeakage, attachForecasts, canTransition, demandData, eligibility, evaluateDemand, fitGlm, fitResponseBaseline, forecastDemand, forecastResponses,
  forecastReturns, movingAverage, opportunityCardSchema, predictDemand, promotionGate, returnData, seasonalNaive, shadowDecision, solveSpd, splitSuccessMetrics, temporalSplit,
  trainDemand, trainResponse, trainReturn, trainSector, wape, type Evaluation, type ResponseObs, type SuccessMetric,
} from '@/loom';
import { addDays } from '@/loom/util/time';
import { TODAY } from '../helpers/loom-dataset';
import { asOf, syntheticHistory } from '../helpers/loom-models';

const ev = (primary: number, g: Record<string, number> = {}, key: Evaluation['primary']['key'] = 'wape'): Evaluation => ({
  primary: { key, value: primary }, guardrails: Object.entries(g).map(([k, v]) => ({ key: k as Evaluation['primary']['key'], value: v })), n_test: 10,
});

describe('phase 6 — numerics', () => {
  it('solves SPD systems and fits a logistic GLM deterministically', () => {
    const x = solveSpd(new Float64Array([4, 1, 1, 3]), new Float64Array([1, 2]), 2);
    expect(x[0]).toBeCloseTo(1 / 11, 9);
    expect(x[1]).toBeCloseTo(7 / 11, 9);
    // y = 1 iff feature on (with noise): the coefficient is clearly positive.
    const rows = Array.from({ length: 200 }, (_, i) => ({ idx: [0, 1], val: [1, i % 2] }));
    const y = rows.map((r, i) => (r.val[1] ? (i % 10 === 1 ? 0 : 1) : i % 10 === 0 ? 1 : 0));
    const a = fitGlm(rows, y, rows.map(() => 1), 2, { family: 'logistic', l2: [0, 0.1] });
    const b = fitGlm(rows, y, rows.map(() => 1), 2, { family: 'logistic', l2: [0, 0.1] });
    expect(a.converged).toBe(true);
    expect(a.coef[1]).toBeGreaterThan(2);
    expect(a.coef).toEqual(b.coef);
  });
});

describe('phase 6 — baselines', () => {
  const tiny = () => {
    const y = new Map<string, number>();
    // Offering o, hour 10: on the same weekday 7/14/21/28 days before 2026-11-09: 4, 2, 0, 2 → mean 2.
    [[7, 4], [14, 2], [21, 0], [28, 2]].forEach(([back, n]) => y.set(`o|${addDays('2026-11-09', -back!)}|10`, n!));
    y.set('o|2026-11-08|10', 6);
    return { offerings: ['o'], hours: [10], from: '2026-09-01', to: '2026-11-08', today: '2026-11-09', y };
  };
  it('seasonal naive = mean of the same weekday and hour over the last 4 weeks at or before the origin', () => {
    expect(seasonalNaive(tiny(), 'o', '2026-11-09', 10, '2026-11-08')).toBe(2);
    // A target two weeks ahead uses only weeks at or before the origin.
    expect(seasonalNaive(tiny(), 'o', addDays('2026-11-09', 7), 10, '2026-11-08')).toBe(2);
  });
  it('moving average = mean of the hour over the last 28 days', () => {
    expect(movingAverage(tiny(), 'o', 10, '2026-11-08')).toBeCloseTo((4 + 2 + 0 + 2 + 6) / 28, 9);
  });
  it('historical-rate baseline per intervention is shrunk to the overall mean', () => {
    const b = fitResponseBaseline([{ at: '2026-01-01', intervention_id: 'a', category: 'x', response: 1 }, { at: '2026-01-02', intervention_id: 'b', category: 'x', response: 0 }]);
    expect(b.overall).toBe(0.5);
    expect(b.means.a).toBeCloseTo((1 + 3 * 0.5) / 4, 6);
  });
});

describe('phase 6 — temporal split (no leakage)', () => {
  it('assertNoLeakage rejects training dates after T and test dates at or before T', () => {
    const s = temporalSplit('2026-01-01', '2026-11-09', 28);
    expect(s.split_at).toBe('2026-10-11');
    expect(s.test_from).toBe('2026-10-12');
    expect(() => assertNoLeakage(s, ['2026-10-12'], [])).toThrow(/leakage/);
    expect(() => assertNoLeakage(s, [], ['2026-10-11'])).toThrow(/leakage/);
    expect(() => assertNoLeakage(s, ['2026-10-11'], ['2026-10-12'])).not.toThrow();
  });

  it('the demand model never sees the test window: changing it changes the evaluation, not the parameters', () => {
    const { ds } = syntheticHistory({ seed: 11 });
    const a = trainDemand(ds);
    const late = { ...ds, transactions: ds.transactions.map((t) => (new Date(t.occurred_at).toISOString().slice(0, 10) > '2026-10-15' ? { ...t, lines: t.lines.map((l) => ({ ...l, qty: 3 })) } : t)) };
    const b = trainDemand(late);
    if (a.status !== 'trained' || b.status !== 'trained') throw new Error('not trained');
    expect(b.model.params).toEqual(a.model.params);
    expect(b.model.candidate.primary.value).not.toBe(a.model.candidate.primary.value);
  });

  it('the return model: labels of the training references end on or before T', () => {
    const { ds } = syntheticHistory({ seed: 12 });
    const a = trainReturn(ds);
    if (a.status !== 'trained') throw new Error('not trained');
    // Remove every visit after T: the parameters are identical (only the test labels change).
    const T = a.model.split.split_at;
    const cut = { ...ds, transactions: ds.transactions.filter((t) => new Date(t.occurred_at + 3 * 3600_000).toISOString().slice(0, 10) <= T || parseInt(t.customer_ref.slice(2, 6), 16) % 3 === 0) };
    const b = trainReturn(cut);
    if (b.status !== 'trained') throw new Error(b.reason);
    expect(b.model.params).toEqual(a.model.params);
    expect(b.model.candidate.primary.value).not.toBe(a.model.candidate.primary.value);
  });
});

describe('phase 6 — learned models beat the baselines on the temporal split', () => {
  const { ds } = syntheticHistory();
  it('demand: Poisson GLM vs the best of seasonal-naive / moving-average (WAPE), deterministic', () => {
    const r = trainDemand(ds);
    if (r.status !== 'trained') throw new Error(r.reason);
    expect(r.model.split.train_to).toBe(r.model.split.split_at);
    expect(r.model.split.test_from > r.model.split.split_at).toBe(true);
    expect(['seasonal_naive_4w', 'moving_average_28d']).toContain(r.model.baseline.algorithm);
    expect(r.model.candidate.primary.value).toBeLessThan(r.model.baseline.primary.value * 0.95);
    const gate = promotionGate({ candidate: r.model.candidate, baseline: r.model.baseline, active: null, margin: 0.05, guardrail_tolerance: 0.05 });
    expect(gate.passed).toBe(true);
    const again = trainDemand(ds);
    expect(again.status === 'trained' && again.model.data_hash).toBe(r.model.data_hash);
    expect(again.status === 'trained' && again.model.params).toEqual(r.model.params);
  });
  it('return probability: logistic ridge vs the cohort historical rate (Brier)', () => {
    const r = trainReturn(ds);
    if (r.status !== 'trained') throw new Error(r.reason);
    expect(r.model.candidate.primary.key).toBe('brier');
    expect(r.model.candidate.primary.value).toBeLessThan(r.model.baseline.primary.value * 0.98);
    expect(promotionGate({ candidate: r.model.candidate, baseline: r.model.baseline, active: null, margin: 0.02, guardrail_tolerance: 0.05 }).passed).toBe(true);
  });
  it('forecasts: daily per offering with a 90% interval, labelled model or baseline', () => {
    const data = demandData(ds);
    const base = forecastDemand(data, 14, null);
    expect(base.length).toBe(data.offerings.length * 14);
    expect(base.every((f) => f.source === 'baseline' && f.model_version_id === null && f.low <= f.value && f.value <= f.high)).toBe(true);
    const r = trainDemand(ds);
    if (r.status !== 'trained') throw new Error('x');
    const m = forecastDemand(data, 14, { params: r.model.params as never, model_version_id: 'v1', version: 1 });
    expect(m.every((f) => f.source === 'model' && f.version === 1 && f.algorithm === 'poisson_glm_v1')).toBe(true);
    expect(predictDemand(r.model.params as never, 'unknown', TODAY, 15)).toBeNull();
    const ret = forecastReturns(returnData(ds), null, data.offerings);
    expect(ret.find((f) => f.subject_key === 'customers:all')!.value).toBeGreaterThan(0);
  });
  it('a business with too little history is not eligible (baseline only, with reasons)', () => {
    const e = eligibility(ds, { min_days: 180, min_completed_transactions: 500 });
    expect(e.eligible).toBe(true);
    const young = asOf(ds, addDays(TODAY, -200));
    const y = eligibility(young, { min_days: 180, min_completed_transactions: 500 });
    expect(y.eligible).toBe(false);
    expect(y.reasons.length).toBeGreaterThan(0);
    expect(eligibility(ds, { min_days: 180, min_completed_transactions: 100_000 }).reasons[0]!.en).toMatch(/completed transactions/);
  });
});

describe('phase 6 — promotion gate', () => {
  it('passes only when the candidate beats BOTH the baseline and the active version by the margin', () => {
    expect(promotionGate({ candidate: ev(0.8), baseline: ev(1), active: null, margin: 0.05, guardrail_tolerance: 0.05 }).passed).toBe(true);
    const vsActive = promotionGate({ candidate: ev(0.8), baseline: ev(1), active: ev(0.82), margin: 0.05, guardrail_tolerance: 0.05 });
    expect(vsActive.passed).toBe(false);
    expect(vsActive.reasons).toEqual(['not_better_than_active']);
    const vsBase = promotionGate({ candidate: ev(0.97), baseline: ev(1), active: ev(2), margin: 0.05, guardrail_tolerance: 0.05 });
    expect(vsBase.reasons).toEqual(['not_better_than_baseline']);
    // A perfect reference cannot be beaten by a margin.
    expect(promotionGate({ candidate: ev(0), baseline: ev(0), active: null, margin: 0.05, guardrail_tolerance: 0.05 }).passed).toBe(false);
  });
  it('a guardrail regression blocks the promotion even with a better primary metric', () => {
    const g = promotionGate({ candidate: ev(0.5, { abs_bias: 0.2 }), baseline: ev(1, { abs_bias: 0.1 }), active: null, margin: 0.05, guardrail_tolerance: 0.05 });
    expect(g.passed).toBe(false);
    expect(g.reasons).toEqual(['guardrail_regression:abs_bias:baseline']);
    expect(promotionGate({ candidate: ev(0.5, { abs_bias: 0.104 }), baseline: ev(1, { abs_bias: 0.1 }), active: null, margin: 0.05, guardrail_tolerance: 0.05 }).passed).toBe(true);
  });
  it('the shadow decision compares realised data and waits for enough of it', () => {
    expect(shadowDecision({ shadow: { primary: 0.3, guardrails: {} }, reference: { primary: 0.35, guardrails: {} }, guardrail_tolerance: 0.05, n: 10, min_n: 7 }).passed).toBe(true);
    expect(shadowDecision({ shadow: { primary: 0.4, guardrails: {} }, reference: { primary: 0.35, guardrails: {} }, guardrail_tolerance: 0.05, n: 10, min_n: 7 }).reasons).toEqual(['worse_than_reference']);
    const p = shadowDecision({ shadow: { primary: 0.3, guardrails: {} }, reference: { primary: 0.35, guardrails: {} }, guardrail_tolerance: 0.05, n: 2, min_n: 7 });
    expect(p.pending).toBe(true);
    expect(p.passed).toBe(false);
  });
  it('status transitions: rollback re-activates only a once-active version', () => {
    expect(canTransition('candidate', 'shadow')).toBe(true);
    expect(canTransition('candidate', 'active')).toBe(false);
    expect(canTransition('shadow', 'active')).toBe(true);
    expect(canTransition('retired', 'active', false)).toBe(false);
    expect(canTransition('retired', 'active', true)).toBe(true);
    expect(wape([[2, 1], [2, 3]])).toBe(0.5);
  });
});

describe('phase 6 — intervention response and sector models', () => {
  const obs = (n: number): ResponseObs[] => Array.from({ length: n }, (_, i) => ({
    at: addDays('2026-01-01', i * 5), intervention_id: i % 2 ? 'reminder' : 'open_slots', category: i % 3 ? 'lapsed_cohort' : 'quiet_capacity',
    response: (i % 2 ? 0.2 : 0.05) + (i % 3 ? 0.05 : 0) + ((i * 7) % 5 - 2) / 100,
  }));
  it('stays baseline below the measured-outcome threshold; trains on a temporal split above it', () => {
    expect(trainResponse(obs(12), { minOutcomes: 30 })).toMatchObject({ status: 'insufficient', reason: 'not_enough_measured_outcomes' });
    const r = trainResponse(obs(40), { minOutcomes: 30 });
    if (r.status !== 'trained') throw new Error('x');
    expect(r.model.split.split_at < r.model.split.test_from).toBe(true);
    expect(r.model.candidate.primary.key).toBe('mae');
    const f = forecastResponses(obs(40), TODAY, null);
    expect(f.every((x) => x.unit === 'ratio' && x.source === 'baseline')).toBe(true);
  });
  it('a sector model needs at least three consenting contributors', () => {
    const a = syntheticHistory({ seed: 21 }).ds;
    const cells = aggregateBusiness(returnData(a), addDays(TODAY, -46));
    expect(cells.every((c) => Object.keys(c).sort().join() === 'cohort,n,pos,ref,single,tenure')).toBe(true);
    expect(trainSector([cells, cells], TODAY)).toMatchObject({ status: 'insufficient', reason: 'not_enough_consenting_businesses', contributors: 2 });
    const b = syntheticHistory({ seed: 22 }).ds, c = syntheticHistory({ seed: 23 }).ds;
    const t = trainSector([cells, aggregateBusiness(returnData(b), addDays(TODAY, -46)), aggregateBusiness(returnData(c), addDays(TODAY, -46))], TODAY);
    expect(t.status).toBe('trained');
    expect(t.contributors).toBe(3);
  });
});

describe('phase 6 — forecasts on cards are labelled and never mixed with goals', () => {
  it('adds separate model_forecast entries with the interval and version; proposed goals are untouched', () => {
    const goal = { metric_key: 'capacity.occupancy@slot:x', baseline: 0.2, target: 0.3, target_kind: 'proposed_goal' as const };
    const card = { period: { from: TODAY, to: addDays(TODAY, 6) }, recommended_action: { intervention_id: 'reminder' }, success_metrics: [goal] as SuccessMetric[] };
    const opps = [{ category: 'lapsed_cohort', card, subject: { offering_ids: ['o1'] }, reserve: { offering_id: 'o1' } }];
    const rows = [
      ...Array.from({ length: 14 }, (_, i) => ({ model_kind: 'demand_forecast' as const, source: 'model' as const, model_version_id: 'v', version: 3, algorithm: 'poisson_glm_v1', subject_key: `offering:o1|date:${addDays(TODAY, i)}`, subject: { offering_id: 'o1', date: addDays(TODAY, i) }, horizon_from: addDays(TODAY, i), horizon_to: addDays(TODAY, i), value: 2, low: 1, high: 3, unit: 'count' as const })),
      { model_kind: 'return_probability' as const, source: 'baseline' as const, model_version_id: null, version: null, algorithm: 'historical_rate_cohort', subject_key: 'customers:offering:o1', subject: {}, horizon_from: TODAY, horizon_to: addDays(TODAY, 44), value: 12, low: 9, high: 15, unit: 'count' as const },
    ];
    expect(attachForecasts(opps, rows)).toBe(2);
    expect(attachForecasts(opps, rows)).toBe(0); // idempotent
    const { goals, forecasts } = splitSuccessMetrics(card.success_metrics);
    expect(goals).toEqual([goal]);
    const demand = forecasts.find((f) => f.metric_key === 'forecast.demand_units@offering:o1')!;
    expect(demand).toMatchObject({ baseline: null, target: 14, target_kind: 'model_forecast', forecast: { source: 'model', version: 3, model_version_id: 'v', interval: 0.9, horizon: { from: TODAY, to: addDays(TODAY, 6) } } });
    expect(demand.forecast!.low).toBeLessThan(14);
    expect(forecasts.find((f) => f.metric_key.startsWith('forecast.returning_customers'))!.forecast).toMatchObject({ source: 'baseline', version: null });
    // The §11.1 schema accepts forecast entries and rejects a forecast label on a goal.
    const sm = opportunityCardSchema.shape.success_metrics;
    expect(sm.safeParse(card.success_metrics).success).toBe(true);
    expect(sm.safeParse([{ ...goal, forecast: demand.forecast }]).success).toBe(false);
    expect(sm.safeParse([{ ...demand, forecast: undefined }]).success).toBe(false);
  });
  it('evaluates any predictor on daily totals', () => {
    const { ds } = syntheticHistory({ seed: 3, customers: 200 });
    const data = demandData(ds);
    const s = temporalSplit(data.from, data.today, 28);
    const zero = evaluateDemand(data, s, () => 0);
    expect(zero.primary.value).toBe(1);
  });
});
