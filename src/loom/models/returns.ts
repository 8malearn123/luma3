import type { CanonicalDataset } from '../contracts/canonical';
import { stableHash } from '../util/text';
import { addDays, localDateOf } from '../util/time';
import { assertNoLeakage, brier, daysBetween, ece, evaluation, logLoss } from './governance';
import { fitGlm, sigmoid, Z90, type SparseRow } from './math';
import type { Evaluation, ForecastRow, KindOutcome, TemporalSplit } from './types';

/**
 * Return probability (phase 6): the probability that a customer with at least
 * one completed visit comes back within RETURN_HORIZON_DAYS of a reference
 * date. Features use only visits on or before the reference date.
 *
 * Baseline `historical_rate_cohort`: the observed return rate per cohort
 * (recency bucket × visit-frequency bucket) on the training references,
 * shrunk to the overall rate. Learned `logistic_ridge_v1`: ridge logistic
 * regression on the cohort plus standardised recency, frequency, tenure,
 * recency ÷ usual gap and average spend. Primary metric Brier score;
 * guardrails log loss and expected calibration error.
 *
 * Split: T = yesterday − horizon (the last reference whose outcome is fully
 * observed). Test = customers at reference T, labelled by visits in
 * (T, T + horizon]. Training references T − horizon − 14k: their labels end
 * on or before T. Customers stay pseudonymous; forecasts are cohort sums.
 */
export const RETURN_ALGORITHM = 'logistic_ridge_v1';
export const RETURN_BASELINE = 'historical_rate_cohort';
export const RETURN_HORIZON_DAYS = 45;
const RECENCY_EDGES = [30, 60, 90, 180];
const FREQ_EDGES = [1, 3];
const N_COHORTS = (RECENCY_EDGES.length + 1) * (FREQ_EDGES.length + 1);
const N_CONT = 6;
const MAX_REFS = 12;
const PRIOR_STRENGTH = 10;

type Visit = { d: string; net: number; offerings: string[] };
export type ReturnData = { today: string; last: string; first: string; visits: Map<string, Visit[]> };
export type Example = { customer: string; ref: string; cohort: number; x: number[]; y: 0 | 1 };

export function returnData(ds: Pick<CanonicalDataset, 'transactions' | 'business' | 'meta'>): ReturnData {
  const tz = ds.business.timezone;
  const last = addDays(ds.meta.today, -1);
  const byCustomer = new Map<string, Map<string, Visit>>();
  let first = last;
  for (const t of ds.transactions) {
    if (t.status !== 'fulfilled' || !t.customer_ref) continue;
    const d = localDateOf(t.occurred_at, tz);
    if (d > last) continue;
    if (d < first) first = d;
    const m = byCustomer.get(t.customer_ref) ?? new Map<string, Visit>();
    const v = m.get(d) ?? { d, net: 0, offerings: [] };
    v.net += t.net_minor;
    for (const l of t.lines) if (!v.offerings.includes(l.offering_id)) v.offerings.push(l.offering_id);
    m.set(d, v);
    byCustomer.set(t.customer_ref, m);
  }
  const visits = new Map([...byCustomer.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([c, m]) => [c, [...m.values()].sort((a, b) => a.d.localeCompare(b.d))]));
  return { today: ds.meta.today, last, first, visits };
}

export const recencyBucket = (days: number) => RECENCY_EDGES.findIndex((e) => days <= e) === -1 ? RECENCY_EDGES.length : RECENCY_EDGES.findIndex((e) => days <= e);
const freqBucket = (n: number) => (FREQ_EDGES.findIndex((e) => n <= e) === -1 ? FREQ_EDGES.length : FREQ_EDGES.findIndex((e) => n <= e));
export const COHORT_LABELS = Array.from({ length: N_COHORTS }, (_, i) => {
  const r = Math.floor(i / (FREQ_EDGES.length + 1)), f = i % (FREQ_EDGES.length + 1);
  const rl = r === 0 ? `0-${RECENCY_EDGES[0]}` : r < RECENCY_EDGES.length ? `${RECENCY_EDGES[r - 1]! + 1}-${RECENCY_EDGES[r]}` : `${RECENCY_EDGES.at(-1)! + 1}+`;
  const fl = f === 0 ? '1' : f < FREQ_EDGES.length ? `${FREQ_EDGES[f - 1]! + 1}-${FREQ_EDGES[f]}` : `${FREQ_EDGES.at(-1)! + 1}+`;
  return `recency:${rl}|visits:${fl}`;
});

/** Features of a customer at `ref` from visits on or before `ref` only (null if never seen or inactive > 2 years). */
export function featuresAt(vs: Visit[], ref: string): { cohort: number; x: number[] } | null {
  let lastD: string | null = null, firstD: string | null = null, total = 0, n365 = 0, net = 0;
  const from365 = addDays(ref, -365);
  for (const v of vs) {
    if (v.d > ref) break;
    firstD ??= v.d; lastD = v.d; total++; net += v.net;
    if (v.d > from365) n365++;
  }
  if (!lastD || !firstD) return null;
  const rec = daysBetween(lastD, ref);
  if (rec > 730) return null;
  const tenure = daysBetween(firstD, ref);
  const gap = total >= 2 ? daysBetween(firstD, lastD) / (total - 1) : null;
  return {
    cohort: recencyBucket(rec) * (FREQ_EDGES.length + 1) + freqBucket(n365),
    x: [Math.log1p(rec), Math.log1p(n365), Math.log1p(tenure), gap ? Math.min(5, rec / Math.max(gap, 1)) : 0, gap ? 0 : 1, Math.log1p(Math.max(0, net / total) / 100)],
  };
}

export function examplesAt(data: ReturnData, ref: string, horizon = RETURN_HORIZON_DAYS): Example[] {
  const out: Example[] = [];
  const end = addDays(ref, horizon);
  for (const [customer, vs] of data.visits) {
    const f = featuresAt(vs, ref);
    if (!f) continue;
    const y = vs.some((v) => v.d > ref && v.d <= end) ? 1 : 0;
    out.push({ customer, ref, cohort: f.cohort, x: f.x, y });
  }
  return out;
}

export type ReturnParams = {
  algorithm: typeof RETURN_ALGORITHM; horizon_days: number; split_at: string; mean: number[]; sd: number[]; coef: number[];
};
export type ReturnBaselineParams = { algorithm: typeof RETURN_BASELINE; horizon_days: number; rates: number[]; overall: number };

/** Reference dates whose labels end on or before `until` (newest first, 14 days apart). */
export function trainingRefs(data: ReturnData, until: string, horizon = RETURN_HORIZON_DAYS) {
  const refs: string[] = [];
  for (let k = 0; k < MAX_REFS; k++) {
    const r = addDays(until, -horizon - 14 * k);
    if (daysBetween(data.first, r) < 30) break;
    refs.push(r);
  }
  return refs;
}

export function fitBaseline(train: Example[], horizon = RETURN_HORIZON_DAYS): ReturnBaselineParams {
  const g = train.length ? train.reduce((s, e) => s + e.y, 0) / train.length : 0;
  const pos = new Array(N_COHORTS).fill(0), n = new Array(N_COHORTS).fill(0);
  for (const e of train) { pos[e.cohort] += e.y; n[e.cohort]++; }
  return { algorithm: RETURN_BASELINE, horizon_days: horizon, overall: r6(g), rates: pos.map((p, i) => r6((p + PRIOR_STRENGTH * g) / (n[i] + PRIOR_STRENGTH))) };
}
export const baselineProb = (b: ReturnBaselineParams, cohort: number) => b.rates[cohort] ?? b.overall;

function design(e: { cohort: number; x: number[] }, mean: number[], sd: number[]): SparseRow {
  const idx = [0, 1 + e.cohort], val = [1, 1];
  for (let j = 0; j < N_CONT; j++) { idx.push(1 + N_COHORTS + j); val.push((e.x[j]! - mean[j]!) / sd[j]!); }
  return { idx, val };
}
export function predictReturn(p: ReturnParams, e: { cohort: number; x: number[] }) {
  const r = design(e, p.mean, p.sd);
  let eta = 0;
  for (let k = 0; k < r.idx.length; k++) eta += p.coef[r.idx[k]!]! * r.val[k]!;
  return sigmoid(eta);
}

export function fitReturn(train: Example[], split: TemporalSplit, horizon = RETURN_HORIZON_DAYS): ReturnParams {
  const mean = Array.from({ length: N_CONT }, (_, j) => train.reduce((s, e) => s + e.x[j]!, 0) / train.length);
  const sd = mean.map((m, j) => Math.max(1e-6, Math.sqrt(train.reduce((s, e) => s + (e.x[j]! - m) ** 2, 0) / train.length)));
  const p = 1 + N_COHORTS + N_CONT;
  const rate = Math.min(0.99, Math.max(0.01, train.reduce((s, e) => s + e.y, 0) / train.length));
  const fit = fitGlm(train.map((e) => design(e, mean, sd)), train.map((e) => e.y), train.map(() => 1), p, { family: 'logistic', l2: Array.from({ length: p }, (_, j) => (j === 0 ? 0 : 1)), init: [Math.log(rate / (1 - rate))] });
  return { algorithm: RETURN_ALGORITHM, horizon_days: horizon, split_at: split.split_at, mean: mean.map(r6), sd: sd.map(r6), coef: fit.coef.map((c) => Math.round(c * 1e8) / 1e8) };
}

export function evaluateReturn(test: Example[], prob: (e: Example) => number): Evaluation {
  const pairs = test.map((e) => [e.y, prob(e)] as [number, number]);
  return evaluation('brier', { brier: brier(pairs), log_loss: logLoss(pairs), ece: ece(pairs) }, ['log_loss', 'ece'], pairs.length);
}

export function returnSplit(data: ReturnData, horizon = RETURN_HORIZON_DAYS): { split: TemporalSplit; refs: string[] } {
  const T = addDays(data.last, -horizon);
  const refs = trainingRefs(data, T, horizon);
  return { split: { train_from: refs.at(-1) ?? addDays(T, -horizon), train_to: T, split_at: T, test_from: addDays(T, 1), test_to: data.last }, refs };
}

export function trainReturn(ds: Pick<CanonicalDataset, 'transactions' | 'business' | 'meta'>): KindOutcome & { data?: ReturnData } {
  const data = returnData(ds);
  const { split, refs } = returnSplit(data);
  // Training labels end on or before T; the test labels lie after T.
  assertNoLeakage(split, refs.map((r) => addDays(r, RETURN_HORIZON_DAYS)), [addDays(split.split_at, 1)]);
  const train = refs.flatMap((r) => examplesAt(data, r));
  const test = examplesAt(data, split.split_at);
  const testPos = test.reduce((s, e) => s + e.y, 0);
  if (train.length < 200 || test.length < 30 || testPos < 5 || testPos === test.length) {
    return { status: 'insufficient', reason: 'not_enough_customer_history', detail: { train_examples: train.length, test_examples: test.length, test_returns: testPos } };
  }
  const params = fitReturn(train, split);
  const base = fitBaseline(train);
  const candidate = evaluateReturn(test, (e) => predictReturn(params, e));
  const baseline = { algorithm: RETURN_BASELINE, ...evaluateReturn(test, (e) => baselineProb(base, e.cohort)) };
  const names = ['log_recency', 'log_visits_365d', 'log_tenure', 'recency_over_gap', 'single_visit', 'log_avg_spend'];
  const explain = [
    ...COHORT_LABELS.map((c, i) => ({ feature: `cohort:${c}`, effect: Math.round(params.coef[1 + i]! * 1000) / 1000 })),
    ...names.map((n, j) => ({ feature: n, effect: Math.round(params.coef[1 + N_COHORTS + j]! * 1000) / 1000 })),
  ];
  return {
    status: 'trained', data,
    model: {
      kind: 'return_probability', algorithm: RETURN_ALGORITHM, split, params: { ...params, baseline: base }, candidate, baseline, n_train: train.length,
      data_hash: stableHash({ split, train: train.map((e) => [e.customer, e.ref, e.y]), test: test.map((e) => [e.customer, e.y]) }).slice(0, 32), explain,
    },
  };
}

export function evaluateReturnParams(data: ReturnData, split: TemporalSplit, p: ReturnParams): Evaluation | null {
  if (p.split_at > split.split_at || p.horizon_days !== RETURN_HORIZON_DAYS) return null;
  return evaluateReturn(examplesAt(data, split.split_at), (e) => predictReturn(p, e));
}

/**
 * Expected returning customers in [today, today + horizon − 1]: overall and
 * per offering (customers who bought it before), 90% interval from the
 * Poisson-binomial variance. `src` null ⇒ the labelled cohort baseline.
 */
export function forecastReturns(data: ReturnData, src: { params: ReturnParams; model_version_id: string; version: number } | null, offeringIds: string[]): ForecastRow[] {
  const horizon = RETURN_HORIZON_DAYS;
  const base = src ? null : fitBaseline(trainingRefs(data, data.last).flatMap((r) => examplesAt(data, r)));
  const groups = new Map<string, { n: number; mu: number; v: number }>([['all', { n: 0, mu: 0, v: 0 }], ...offeringIds.map((o) => [`offering:${o}`, { n: 0, mu: 0, v: 0 }] as const)]);
  for (const [, vs] of data.visits) {
    const f = featuresAt(vs, data.last);
    if (!f) continue;
    const p = src ? predictReturn(src.params, f) : baselineProb(base!, f.cohort);
    const keys = ['all', ...new Set(vs.flatMap((v) => v.offerings).map((o) => `offering:${o}`))];
    for (const k of keys) { const g = groups.get(k); if (g) { g.n++; g.mu += p; g.v += p * (1 - p); } }
  }
  const from = data.today, to = addDays(data.today, horizon - 1);
  return [...groups.entries()].filter(([, g]) => g.n > 0).map(([k, g]) => {
    const half = Z90 * Math.sqrt(g.v);
    const v = r3(g.mu);
    return {
      model_kind: 'return_probability' as const, source: src ? 'model' as const : 'baseline' as const, model_version_id: src?.model_version_id ?? null, version: src?.version ?? null,
      algorithm: src ? RETURN_ALGORITHM : RETURN_BASELINE, subject_key: `customers:${k}`, subject: { cohort: k, customers: g.n, horizon_days: horizon },
      horizon_from: from, horizon_to: to, value: v, low: Math.min(v, r3(Math.max(0, g.mu - half))), high: Math.max(v, r3(Math.min(g.n, g.mu + half))), unit: 'count' as const,
    };
  });
}

const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
const r3 = (x: number) => Math.round(x * 1000) / 1000;
