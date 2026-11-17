import { stableHash } from '../util/text';
import { addDays } from '../util/time';
import { assertNoLeakage, evaluation, mae } from './governance';
import { fitRidge, Z90, type SparseRow } from './math';
import type { Evaluation, ForecastRow, KindOutcome, TemporalSplit } from './types';

/**
 * Intervention response (phase 6): the relative change of the primary goal
 * metric measured for an initiative (phase 5 `loom.outcomes`), per
 * intervention and opportunity category.
 *
 * Baseline `historical_mean_by_intervention`: the mean measured response per
 * intervention, shrunk to the overall mean (3 pseudo-observations). Learned
 * `ridge_linear_v1` (intervention + category effects) only once at least
 * `min_outcomes` measured outcomes exist; otherwise the kind stays baseline.
 * Split by measurement date: the latest 20% (≥ 5) are the test set.
 * Primary metric MAE; guardrail |mean error| (`abs_bias`).
 */
export const RESPONSE_ALGORITHM = 'ridge_linear_v1';
export const RESPONSE_BASELINE = 'historical_mean_by_intervention';
const SHRINK = 3;
const HORIZON_DAYS = 30;

export type ResponseObs = { at: string; intervention_id: string; category: string; response: number };
export type ResponseBaselineParams = { algorithm: typeof RESPONSE_BASELINE; overall: number; means: Record<string, number>; counts: Record<string, number>; sd: number };
export type ResponseParams = { algorithm: typeof RESPONSE_ALGORITHM; split_at: string; interventions: string[]; categories: string[]; coef: number[]; residual_sd: number };

export function fitResponseBaseline(obs: ResponseObs[]): ResponseBaselineParams {
  const overall = obs.length ? obs.reduce((s, o) => s + o.response, 0) / obs.length : 0;
  const sums: Record<string, number> = {}, counts: Record<string, number> = {};
  for (const o of obs) { sums[o.intervention_id] = (sums[o.intervention_id] ?? 0) + o.response; counts[o.intervention_id] = (counts[o.intervention_id] ?? 0) + 1; }
  const means = Object.fromEntries(Object.keys(sums).sort().map((k) => [k, r6((sums[k]! + SHRINK * overall) / (counts[k]! + SHRINK))]));
  const sd = obs.length > 1 ? Math.sqrt(obs.reduce((s, o) => s + (o.response - overall) ** 2, 0) / (obs.length - 1)) : 0;
  return { algorithm: RESPONSE_BASELINE, overall: r6(overall), means, counts, sd: r6(sd) };
}
export const baselineResponse = (b: ResponseBaselineParams, interventionId: string) => b.means[interventionId] ?? b.overall;

function row(p: Pick<ResponseParams, 'interventions' | 'categories'>, o: { intervention_id: string; category: string }): SparseRow {
  const idx = [0], val = [1];
  const i = p.interventions.indexOf(o.intervention_id), c = p.categories.indexOf(o.category);
  if (i >= 0) { idx.push(1 + i); val.push(1); }
  if (c >= 0) { idx.push(1 + p.interventions.length + c); val.push(1); }
  return { idx, val };
}
export function predictResponse(p: ResponseParams, o: { intervention_id: string; category: string }) {
  const r = row(p, o);
  return r.idx.reduce((s, j, k) => s + p.coef[j]! * r.val[k]!, 0);
}

export function responseSplit(obs: ResponseObs[]): TemporalSplit | null {
  const sorted = [...obs].sort((a, b) => a.at.localeCompare(b.at));
  if (sorted.length < 10) return null;
  const T = sorted[Math.floor(sorted.length * 0.8) - 1]!.at;
  const test = sorted.filter((o) => o.at > T);
  if (test.length < 5) return null;
  return { train_from: sorted[0]!.at, train_to: T, split_at: T, test_from: addDays(T, 1), test_to: sorted.at(-1)!.at };
}

export function evaluateResponse(test: ResponseObs[], predict: (o: ResponseObs) => number): Evaluation {
  const pairs = test.map((o) => [o.response, predict(o)] as [number, number]);
  const bias = pairs.length ? Math.abs(pairs.reduce((s, [y, f]) => s + f - y, 0) / pairs.length) : NaN;
  return evaluation('mae', { mae: mae(pairs), abs_bias: bias }, ['abs_bias'], pairs.length);
}

export function trainResponse(obs: ResponseObs[], opts: { minOutcomes: number }): KindOutcome {
  if (obs.length < opts.minOutcomes) return { status: 'insufficient', reason: 'not_enough_measured_outcomes', detail: { outcomes: obs.length, required: opts.minOutcomes } };
  const split = responseSplit(obs);
  if (!split) return { status: 'insufficient', reason: 'not_enough_recent_outcomes', detail: { outcomes: obs.length } };
  const train = obs.filter((o) => o.at <= split.split_at), test = obs.filter((o) => o.at > split.split_at);
  assertNoLeakage(split, train.map((o) => o.at), test.map((o) => o.at));
  const interventions = [...new Set(train.map((o) => o.intervention_id))].sort();
  const categories = [...new Set(train.map((o) => o.category))].sort();
  const p = 1 + interventions.length + categories.length;
  const coef = fitRidge(train.map((o) => row({ interventions, categories }, o)), train.map((o) => o.response), train.map(() => 1), p, Array.from({ length: p }, (_, j) => (j === 0 ? 0 : 2)));
  const proto = { interventions, categories, coef };
  const res = train.map((o) => o.response - predictResponse({ ...proto, algorithm: RESPONSE_ALGORITHM, split_at: split.split_at, residual_sd: 0 }, o));
  const residual_sd = Math.sqrt(res.reduce((s, x) => s + x * x, 0) / Math.max(1, res.length - 1));
  const params: ResponseParams = { algorithm: RESPONSE_ALGORITHM, split_at: split.split_at, interventions, categories, coef: coef.map((c) => Math.round(c * 1e8) / 1e8), residual_sd: r6(residual_sd) };
  const base = fitResponseBaseline(train);
  return {
    status: 'trained',
    model: {
      kind: 'intervention_response', algorithm: RESPONSE_ALGORITHM, split, params: { ...params, baseline: base },
      candidate: evaluateResponse(test, (o) => predictResponse(params, o)),
      baseline: { algorithm: RESPONSE_BASELINE, ...evaluateResponse(test, (o) => baselineResponse(base, o.intervention_id)) },
      n_train: train.length, data_hash: stableHash({ split, obs: [...obs].sort((a, b) => a.at.localeCompare(b.at) || a.intervention_id.localeCompare(b.intervention_id)) }).slice(0, 32),
      explain: [...interventions.map((i, k) => ({ feature: `intervention:${i}`, effect: r6(params.coef[1 + k]!) })), ...categories.map((c, k) => ({ feature: `category:${c}`, effect: r6(params.coef[1 + interventions.length + k]!) }))],
    },
  };
}

export function evaluateResponseParams(obs: ResponseObs[], split: TemporalSplit, p: ResponseParams): Evaluation | null {
  if (p.split_at > split.split_at) return null;
  return evaluateResponse(obs.filter((o) => o.at > split.split_at), (o) => predictResponse(p, o));
}

/** Expected relative response per (intervention, category) seen in the history; baseline needs ≥ 3 observations of the intervention. */
export function forecastResponses(obs: ResponseObs[], today: string, src: { params: ResponseParams; model_version_id: string; version: number } | null): ForecastRow[] {
  const base = fitResponseBaseline(obs);
  const pairs = [...new Set(obs.map((o) => `${o.intervention_id}|${o.category}`))].sort();
  const out: ForecastRow[] = [];
  for (const pair of pairs) {
    const [intervention_id, category] = pair.split('|') as [string, string];
    if (!src && (base.counts[intervention_id] ?? 0) < 3) continue;
    const v = r6(src ? predictResponse(src.params, { intervention_id, category }) : baselineResponse(base, intervention_id));
    const half = Z90 * (src ? src.params.residual_sd : base.sd / Math.sqrt(Math.max(1, base.counts[intervention_id] ?? 1)));
    out.push({
      model_kind: 'intervention_response', source: src ? 'model' : 'baseline', model_version_id: src?.model_version_id ?? null, version: src?.version ?? null,
      algorithm: src ? RESPONSE_ALGORITHM : RESPONSE_BASELINE, subject_key: `intervention:${intervention_id}|category:${category}`,
      subject: { intervention_id, category, observations: base.counts[intervention_id] ?? 0 }, horizon_from: today, horizon_to: addDays(today, HORIZON_DAYS - 1),
      value: v, low: r6(v - half), high: r6(v + half), unit: 'ratio',
    });
  }
  return out;
}

const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
