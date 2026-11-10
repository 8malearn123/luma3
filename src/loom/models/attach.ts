import type { ForecastLabel, SuccessMetric } from '../contracts/opportunity';
import { Z90 } from './math';
import type { ForecastRow } from './types';

/**
 * Puts forecasts on opportunity cards (pure). A forecast is a separate
 * `success_metrics` entry with `target_kind: 'model_forecast'`, `baseline:
 * null` and a `forecast` label (source model | baseline, version, 90%
 * interval, horizon) — it never replaces or alters a `proposed_goal` entry.
 * Rows passed here must already be filtered to active versions or labelled
 * baselines (see store.latestForecasts).
 *
 *  - demand_forecast  → `forecast.demand_units@offering:<id>` summed over the
 *    card period ∩ forecast horizon (interval from the summed variances);
 *  - return_probability → lapsed-cohort cards: `forecast.returning_customers@offering:<id>`;
 *  - intervention_response → `forecast.intervention_response@intervention:<id>` (relative change).
 */
type CardLike = {
  category: string;
  card: { period: { from: string; to: string }; recommended_action: { intervention_id: string }; success_metrics: SuccessMetric[] };
  subject: { offering_ids: string[] };
  reserve?: { offering_id: string | null };
};

const label = (r: ForecastRow, low: number, high: number, from: string, to: string): ForecastLabel => ({
  source: r.source, model_kind: r.model_kind, algorithm: r.algorithm, model_version_id: r.model_version_id, version: r.version, low, high, interval: 0.9, horizon: { from, to }, unit: r.unit,
});

/** Demand forecast for an offering over [from, to] (null when the horizon does not overlap or there is no row). */
export function demandForecastFor(rows: ForecastRow[], offeringId: string, from: string, to: string): { value: number; low: number; high: number; from: string; to: string; row: ForecastRow } | null {
  const days = rows.filter((r) => r.model_kind === 'demand_forecast' && r.subject.offering_id === offeringId && r.horizon_from >= from && r.horizon_to <= to);
  if (!days.length) return null;
  let mu = 0, v = 0;
  for (const r of days) { mu += r.value; v += ((r.high - r.low) / (2 * Z90)) ** 2; }
  const half = Z90 * Math.sqrt(v);
  const sorted = days.map((r) => r.horizon_from).sort();
  return { value: r3(mu), low: r3(Math.max(0, mu - half)), high: r3(mu + half), from: sorted[0]!, to: sorted.at(-1)!, row: days[0]! };
}

export function attachForecasts<T extends CardLike>(opps: T[], rows: ForecastRow[]): number {
  if (!rows.length) return 0;
  let n = 0;
  for (const o of opps) {
    const add = (m: SuccessMetric) => { if (!o.card.success_metrics.some((x) => x.metric_key === m.metric_key && x.target_kind === 'model_forecast')) { o.card.success_metrics.push(m); n++; } };
    const offering = o.reserve?.offering_id ?? o.subject.offering_ids[0] ?? null;
    if (offering) {
      const f = demandForecastFor(rows, offering, o.card.period.from, o.card.period.to);
      if (f) add({ metric_key: `forecast.demand_units@offering:${offering}`, baseline: null, target: f.value, target_kind: 'model_forecast', forecast: label(f.row, f.low, f.high, f.from, f.to) });
    }
    if (o.category === 'lapsed_cohort' && offering) {
      const r = rows.find((x) => x.model_kind === 'return_probability' && x.subject_key === `customers:offering:${offering}`);
      if (r) add({ metric_key: `forecast.returning_customers@offering:${offering}`, baseline: null, target: r.value, target_kind: 'model_forecast', forecast: label(r, r.low, r.high, r.horizon_from, r.horizon_to) });
    }
    const iv = o.card.recommended_action.intervention_id;
    const r = rows.find((x) => x.model_kind === 'intervention_response' && x.subject_key === `intervention:${iv}|category:${o.category}`);
    if (r) add({ metric_key: `forecast.intervention_response@intervention:${iv}`, baseline: null, target: r.value, target_kind: 'model_forecast', forecast: label(r, r.low, r.high, r.horizon_from, r.horizon_to) });
  }
  return n;
}

/** Splits success metrics into proposed goals and forecasts (UI, plans): they are never mixed. */
export function splitSuccessMetrics<M extends { target_kind: 'proposed_goal' | 'model_forecast' }>(ms: M[]) {
  return { goals: ms.filter((m) => m.target_kind === 'proposed_goal'), forecasts: ms.filter((m) => m.target_kind === 'model_forecast') };
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;
