import type { CanonicalDataset } from '../contracts/canonical';
import { L, type Localized } from '../util/text';
import { addDays, localDateOf } from '../util/time';
import type { Evaluation, GateResult, MetricKey, TemporalSplit } from './types';

/**
 * Governance (§10.5), pure:
 *  - eligibility per business from the platform thresholds (days of history
 *    and completed transactions) — below them: baseline only, with reasons;
 *  - the strict temporal split (train ≤ T, test > T; never random);
 *  - the promotion gate: the candidate must beat BOTH the active version and
 *    the baseline by the declared margin on the declared metric, with no
 *    guardrail metric worse than either reference beyond the tolerance;
 *  - the shadow decision on realised data.
 */
export type Eligibility = {
  eligible: boolean;
  history_days: number;
  completed_transactions: number;
  thresholds: { min_days: number; min_completed_transactions: number };
  reasons: Localized[];
};

export function eligibility(ds: Pick<CanonicalDataset, 'transactions' | 'business' | 'meta'>, thresholds: { min_days: number; min_completed_transactions: number }): Eligibility {
  const sales = ds.transactions.filter((t) => t.status === 'fulfilled');
  const first = sales.reduce((m, t) => Math.min(m, t.occurred_at), Infinity);
  const firstDate = Number.isFinite(first) ? localDateOf(first, ds.business.timezone) : ds.meta.today;
  const days = Math.max(0, daysBetween(firstDate, ds.meta.today));
  const reasons: Localized[] = [];
  if (days < thresholds.min_days) reasons.push(L(`سجل البيانات ${days} يومًا والحد المطلوب ${thresholds.min_days} يومًا.`, `Data history is ${days} days; ${thresholds.min_days} days are required.`));
  if (sales.length < thresholds.min_completed_transactions) reasons.push(L(`المعاملات المكتملة ${sales.length} والحد المطلوب ${thresholds.min_completed_transactions}.`, `${sales.length} completed transactions; ${thresholds.min_completed_transactions} are required.`));
  return { eligible: reasons.length === 0, history_days: days, completed_transactions: sales.length, thresholds, reasons };
}

export const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/** Split point T = last complete day − testDays. Train window [from, T], test window (T, last complete day]. */
export function temporalSplit(firstDate: string, today: string, testDays: number): TemporalSplit {
  const last = addDays(today, -1);
  const T = addDays(last, -testDays);
  return { train_from: firstDate < T ? firstDate : addDays(T, -1), train_to: T, split_at: T, test_from: addDays(T, 1), test_to: last };
}

/** Throws if any training date is after T or any test date is not after T (no leakage, used by tests and the trainers). */
export function assertNoLeakage(split: TemporalSplit, trainDates: Iterable<string>, testDates: Iterable<string>) {
  for (const d of trainDates) if (d > split.split_at) throw new Error(`leakage: training date ${d} after split ${split.split_at}`);
  for (const d of testDates) if (d <= split.split_at) throw new Error(`leakage: test date ${d} not after split ${split.split_at}`);
}

/**
 * Promotion gate. Every metric is lower-is-better. The candidate passes when
 *   primary(candidate) ≤ primary(ref) × (1 − margin)          for ref ∈ {baseline, active?}
 *   guardrail(candidate) ≤ guardrail(ref) × (1 + tolerance)   for every guardrail and ref
 * A reference of 0 on the primary metric cannot be beaten by a margin (fails).
 */
export function promotionGate(input: { candidate: Evaluation; baseline: Evaluation; active: Evaluation | null; margin: number; guardrail_tolerance: number }): GateResult {
  const refs: Array<['baseline' | 'active', Evaluation]> = [['baseline', input.baseline]];
  if (input.active) refs.push(['active', input.active]);
  const metric = input.candidate.primary.key;
  const checks: GateResult['checks'] = [];
  const guardrails: GateResult['guardrails'] = [];
  const reasons: string[] = [];
  for (const [against, ref] of refs) {
    if (ref.primary.key !== metric) throw new Error('gate: primary metrics differ');
    const required = ref.primary.value * (1 - input.margin);
    const passed = Number.isFinite(input.candidate.primary.value) && ref.primary.value > 0 && input.candidate.primary.value <= required + 1e-12;
    checks.push({ against, metric, candidate: r6(input.candidate.primary.value), reference: r6(ref.primary.value), required: r6(required), passed });
    if (!passed) reasons.push(`not_better_than_${against}`);
    for (const g of input.candidate.guardrails) {
      const rg = ref.guardrails.find((x) => x.key === g.key);
      if (!rg) continue;
      const limit = rg.value * (1 + input.guardrail_tolerance);
      const ok = g.value <= limit + 1e-12;
      guardrails.push({ against, metric: g.key, candidate: r6(g.value), reference: r6(rg.value), limit: r6(limit), passed: ok });
      if (!ok) reasons.push(`guardrail_regression:${g.key}:${against}`);
    }
  }
  return { passed: reasons.length === 0, metric, margin: input.margin, guardrail_tolerance: input.guardrail_tolerance, checks, guardrails, reasons };
}

/**
 * Shadow decision on realised data: the shadow version must not be worse than
 * the reference (active version or baseline) on the primary metric and must
 * respect the guardrail tolerance. Realised windows are short, so no margin is
 * required here (the margin was required at the gate).
 */
export function shadowDecision(input: { shadow: { primary: number; guardrails: Record<string, number> }; reference: { primary: number; guardrails: Record<string, number> }; guardrail_tolerance: number; n: number; min_n: number }) {
  const reasons: string[] = [];
  if (input.n < input.min_n) reasons.push('not_enough_realised_data');
  if (!(input.shadow.primary <= input.reference.primary + 1e-12)) reasons.push('worse_than_reference');
  for (const [k, v] of Object.entries(input.shadow.guardrails)) {
    const ref = input.reference.guardrails[k];
    if (ref !== undefined && v > ref * (1 + input.guardrail_tolerance) + 1e-12) reasons.push(`guardrail_regression:${k}`);
  }
  return { passed: reasons.length === 0, pending: input.n < input.min_n, reasons };
}

const r6 = (x: number) => Math.round(x * 1e6) / 1e6;

/** Lower-is-better metrics (shared by the trainers and the shadow evaluation). */
export function wape(pairs: Array<[number, number]>) { const den = pairs.reduce((s, [y]) => s + y, 0); return den > 0 ? pairs.reduce((s, [y, f]) => s + Math.abs(f - y), 0) / den : NaN; }
export function mae(pairs: Array<[number, number]>) { return pairs.length ? pairs.reduce((s, [y, f]) => s + Math.abs(f - y), 0) / pairs.length : NaN; }
export function absBias(pairs: Array<[number, number]>) { const den = pairs.reduce((s, [y]) => s + y, 0); return den > 0 ? Math.abs(pairs.reduce((s, [y, f]) => s + f - y, 0)) / den : NaN; }
export function brier(pairs: Array<[number, number]>) { return pairs.length ? pairs.reduce((s, [y, p]) => s + (p - y) ** 2, 0) / pairs.length : NaN; }
export function logLoss(pairs: Array<[number, number]>) {
  const e = 1e-6;
  return pairs.length ? -pairs.reduce((s, [y, p]) => { const q = Math.min(1 - e, Math.max(e, p)); return s + (y ? Math.log(q) : Math.log(1 - q)); }, 0) / pairs.length : NaN;
}
/** Expected calibration error, 10 equal-width bins. */
export function ece(pairs: Array<[number, number]>) {
  if (!pairs.length) return NaN;
  const bins = Array.from({ length: 10 }, () => ({ n: 0, y: 0, p: 0 }));
  for (const [y, p] of pairs) { const b = bins[Math.min(9, Math.floor(p * 10))]!; b.n++; b.y += y; b.p += p; }
  return bins.reduce((s, b) => s + (b.n ? (b.n / pairs.length) * Math.abs(b.y / b.n - b.p / b.n) : 0), 0);
}

export const evaluation = (primary: MetricKey, values: Partial<Record<MetricKey, number>>, guardrails: MetricKey[], n: number): Evaluation => ({
  primary: { key: primary, value: values[primary]! }, guardrails: guardrails.map((key) => ({ key, value: values[key]! })), n_test: n,
});
