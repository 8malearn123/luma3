import { stableHash } from '../util/text';
import { addDays } from '../util/time';
import { assertNoLeakage, brier, daysBetween, ece, evaluation, logLoss } from './governance';
import { fitGlm, sigmoid, type SparseRow } from './math';
import { examplesAt, RETURN_HORIZON_DAYS, trainingRefs, type ReturnData } from './returns';
import type { Evaluation, KindOutcome, TemporalSplit } from './types';

/**
 * Sector return-probability model (phase 6, §10.5): trained ONLY on
 * pseudonymised aggregates of businesses whose owner gave explicit
 * shared-training consent. Each contributing business is reduced to counts
 * per (reference date, cohort, tenure bucket, single-visit flag) — no
 * customer, no business id, no amounts leave the business. At least
 * MIN_CONTRIBUTORS businesses are required (fewer could reveal one).
 *
 * Baseline: pooled return rate per cohort. Learned `sector_logistic_v1`:
 * ridge logistic regression on cohort + tenure bucket + single-visit flag,
 * weighted by the counts. Same temporal split, metrics and gate as the
 * business model.
 */
export const SECTOR_ALGORITHM = 'sector_logistic_v1';
export const SECTOR_BASELINE = 'pooled_rate_cohort';
export const MIN_CONTRIBUTORS = 3;
const TENURE_EDGES = [180, 365];
const N_COHORTS = 15;

export type AggregateCell = { ref: string; cohort: number; tenure: number; single: 0 | 1; n: number; pos: number };

const tenureBucket = (logTenure: number) => { const d = Math.expm1(logTenure); return d <= TENURE_EDGES[0]! ? 0 : d <= TENURE_EDGES[1]! ? 1 : 2; };

/** Reduces one consenting business to aggregate counts relative to the sector split point T. */
export function aggregateBusiness(data: ReturnData, T: string): AggregateCell[] {
  const refs = [...trainingRefs(data, T), T];
  const cells = new Map<string, AggregateCell>();
  for (const ref of refs) {
    if (daysBetween(data.first, ref) < 30) continue;
    for (const e of examplesAt(data, ref)) {
      const tenure = tenureBucket(e.x[2]!), single = e.x[4] ? 1 : 0;
      const k = `${ref}|${e.cohort}|${tenure}|${single}`;
      const c = cells.get(k) ?? { ref, cohort: e.cohort, tenure, single: single as 0 | 1, n: 0, pos: 0 };
      c.n++; c.pos += e.y;
      cells.set(k, c);
    }
  }
  return [...cells.values()];
}

export type SectorParams = { algorithm: typeof SECTOR_ALGORITHM; horizon_days: number; split_at: string; coef: number[]; baseline: { rates: number[]; overall: number } };

function row(c: Pick<AggregateCell, 'cohort' | 'tenure' | 'single'>): SparseRow {
  return { idx: [0, 1 + c.cohort, 1 + N_COHORTS + c.tenure, 1 + N_COHORTS + 3], val: [1, 1, 1, c.single] };
}
export const predictSector = (p: Pick<SectorParams, 'coef'>, c: Pick<AggregateCell, 'cohort' | 'tenure' | 'single'>) => { const r = row(c); return sigmoid(r.idx.reduce((s, j, k) => s + p.coef[j]! * r.val[k]!, 0)); };

function evalCells(cells: AggregateCell[], prob: (c: AggregateCell) => number): Evaluation {
  // Expand counts into weighted pairs (exact for Brier / log loss / ECE).
  const pairs: Array<[number, number]> = [];
  for (const c of cells) { const p = prob(c); for (let i = 0; i < c.pos; i++) pairs.push([1, p]); for (let i = 0; i < c.n - c.pos; i++) pairs.push([0, p]); }
  return evaluation('brier', { brier: brier(pairs), log_loss: logLoss(pairs), ece: ece(pairs) }, ['log_loss', 'ece'], pairs.length);
}

export function sectorSplit(today: string): TemporalSplit {
  const last = addDays(today, -1);
  const T = addDays(last, -RETURN_HORIZON_DAYS);
  return { train_from: addDays(T, -RETURN_HORIZON_DAYS - 14 * 11), train_to: T, split_at: T, test_from: addDays(T, 1), test_to: last };
}

export function trainSector(contributions: AggregateCell[][], today: string): KindOutcome & { contributors: number } {
  const contributors = contributions.filter((c) => c.length > 0).length;
  if (contributors < MIN_CONTRIBUTORS) return { status: 'insufficient', reason: 'not_enough_consenting_businesses', detail: { contributors, required: MIN_CONTRIBUTORS }, contributors };
  const split = sectorSplit(today);
  const cells = contributions.flat();
  const train = cells.filter((c) => c.ref < split.split_at), test = cells.filter((c) => c.ref === split.split_at);
  assertNoLeakage(split, train.map((c) => addDays(c.ref, RETURN_HORIZON_DAYS)), [addDays(split.split_at, 1)]);
  const nTrain = train.reduce((s, c) => s + c.n, 0), nTest = test.reduce((s, c) => s + c.n, 0);
  if (nTrain < 500 || nTest < 50) return { status: 'insufficient', reason: 'not_enough_pooled_history', detail: { train_examples: nTrain, test_examples: nTest }, contributors };
  // Baseline: pooled rate per cohort (shrunk to the overall rate).
  const g = train.reduce((s, c) => s + c.pos, 0) / nTrain;
  const pos = new Array(N_COHORTS).fill(0), n = new Array(N_COHORTS).fill(0);
  for (const c of train) { pos[c.cohort] += c.pos; n[c.cohort] += c.n; }
  const rates = pos.map((p, i) => Math.round(((p + 10 * g) / (n[i] + 10)) * 1e6) / 1e6);
  const rows: SparseRow[] = [], y: number[] = [], w: number[] = [];
  for (const c of train) { if (c.pos) { rows.push(row(c)); y.push(1); w.push(c.pos); } if (c.n - c.pos) { rows.push(row(c)); y.push(0); w.push(c.n - c.pos); } }
  const p = 1 + N_COHORTS + 3 + 1;
  const rate = Math.min(0.99, Math.max(0.01, g));
  const fit = fitGlm(rows, y, w, p, { family: 'logistic', l2: Array.from({ length: p }, (_, j) => (j === 0 ? 0 : 1)), init: [Math.log(rate / (1 - rate))] });
  const params: SectorParams = { algorithm: SECTOR_ALGORITHM, horizon_days: RETURN_HORIZON_DAYS, split_at: split.split_at, coef: fit.coef.map((c) => Math.round(c * 1e8) / 1e8), baseline: { rates, overall: Math.round(g * 1e6) / 1e6 } };
  return {
    status: 'trained', contributors,
    model: {
      kind: 'return_probability', algorithm: SECTOR_ALGORITHM, split, params, n_train: nTrain,
      candidate: evalCells(test, (c) => predictSector(params, c)),
      baseline: { algorithm: SECTOR_BASELINE, ...evalCells(test, (c) => rates[c.cohort] ?? g) },
      data_hash: stableHash({ split, cells: cells.map((c) => [c.ref, c.cohort, c.tenure, c.single, c.n, c.pos]).sort() }).slice(0, 32),
      explain: [{ feature: 'contributors', effect: contributors }],
    },
  };
}

export function evaluateSectorParams(contributions: AggregateCell[][], split: TemporalSplit, p: SectorParams): Evaluation | null {
  if (p.split_at > split.split_at) return null;
  return evalCells(contributions.flat().filter((c) => c.ref === split.split_at), (c) => predictSector(p, c));
}
