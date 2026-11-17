import type { CanonicalDataset } from '../contracts/canonical';
import { stableHash } from '../util/text';
import { addDays, dateRange, localDateOf, localHour, weekdayOf } from '../util/time';
import { absBias, assertNoLeakage, daysBetween, evaluation, mae, temporalSplit, wape } from './governance';
import { fitGlm, Z90, type SparseRow } from './math';
import type { Evaluation, ForecastRow, KindOutcome, TemporalSplit } from './types';

/**
 * Demand forecast per offering × day × hour (phase 6).
 *
 * Series: completed units (fulfilled transaction lines) per active offering,
 * local date and local hour, zero-filled over the observed hours.
 * Baselines (always available, deterministic):
 *   - seasonal_naive_4w: mean of the same weekday and hour over the last 4
 *     weeks at or before the forecast origin;
 *   - moving_average_28d: mean of the same hour over the last 28 days.
 * Learned: `poisson_glm_v1`, a ridge-penalised Poisson regression with
 * offering, weekday, hour, offering×weekday, offering×hour effects and two
 * nested recent-level effects (the last 56 and 28 days before T, carried
 * into the forecast), recency-weighted (half-life 120 days). Coefficients are
 * multiplicative effects (explainable). Evaluated on daily totals per
 * offering: WAPE (primary), hourly MAE and absolute bias (guardrails).
 */
export const DEMAND_ALGORITHM = 'poisson_glm_v1';
export const DEMAND_BASELINES = ['seasonal_naive_4w', 'moving_average_28d'] as const;
export type DemandBaseline = (typeof DEMAND_BASELINES)[number];
export const DEMAND_TEST_DAYS = 28;
const MAX_HISTORY_DAYS = 365;
const MIN_UNITS = 5;
const MAX_CELLS = 250_000;
const HALF_LIFE_DAYS = 120;
const RECENT_DAYS = [56, 28] as const;

export type DemandData = { offerings: string[]; hours: number[]; from: string; to: string; today: string; y: Map<string, number> };
const key = (o: string, d: string, h: number) => `${o}|${d}|${h}`;

/** Builds the zero-filled series from the canonical dataset (data up to yesterday; today is partial). */
export function demandData(ds: Pick<CanonicalDataset, 'transactions' | 'offerings' | 'business' | 'meta'>): DemandData {
  const tz = ds.business.timezone;
  const today = ds.meta.today;
  const last = addDays(today, -1);
  const minFrom = addDays(today, -MAX_HISTORY_DAYS);
  const active = new Set(ds.offerings.filter((o) => o.status === 'active').map((o) => o.id));
  const y = new Map<string, number>();
  const units = new Map<string, number>();
  const hourUnits = new Map<number, number>();
  let first = last;
  for (const t of ds.transactions) {
    if (t.status !== 'fulfilled') continue;
    for (const l of t.lines) {
      if (!active.has(l.offering_id)) continue;
      const d = localDateOf(l.starts_at, tz);
      if (d < minFrom || d > last) continue;
      const h = localHour(l.starts_at, tz);
      const k = key(l.offering_id, d, h);
      y.set(k, (y.get(k) ?? 0) + l.qty);
      units.set(l.offering_id, (units.get(l.offering_id) ?? 0) + l.qty);
      hourUnits.set(h, (hourUnits.get(h) ?? 0) + l.qty);
      if (d < first) first = d;
    }
  }
  const total = [...hourUnits.values()].reduce((a, b) => a + b, 0);
  const hours = [...hourUnits.entries()].filter(([, n]) => n >= total * 0.01).sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 16).map(([h]) => h).sort((a, b) => a - b);
  const offerings = [...units.entries()].filter(([, n]) => n >= MIN_UNITS).map(([o]) => o).sort();
  return { offerings, hours, from: first, to: last, today, y };
}

export const yOf = (data: DemandData, o: string, d: string, h: number) => (d < data.from || d > data.to ? 0 : data.y.get(key(o, d, h)) ?? 0);

// ── Baselines (origin = last date whose data may be used) ───────────────────
export function seasonalNaive(data: DemandData, o: string, d: string, h: number, origin: string, weeks = 4) {
  const back = Math.max(1, Math.ceil(daysBetween(origin, d) / 7));
  let s = 0, n = 0;
  for (let k = 0; k < weeks; k++) {
    const src = addDays(d, -7 * (back + k));
    if (src < data.from) break;
    s += yOf(data, o, src, h); n++;
  }
  return n ? s / n : 0;
}
export function movingAverage(data: DemandData, o: string, h: number, origin: string, days = 28) {
  let s = 0, n = 0;
  for (let i = 0; i < days; i++) { const src = addDays(origin, -i); if (src < data.from) break; s += yOf(data, o, src, h); n++; }
  return n ? s / n : 0;
}
export function baselinePredict(kind: DemandBaseline, data: DemandData, o: string, d: string, h: number, origin: string) {
  return kind === 'seasonal_naive_4w' ? seasonalNaive(data, o, d, h, origin) : movingAverage(data, o, h, origin);
}

// ── Learned model ───────────────────────────────────────────────────────────
export type DemandParams = {
  algorithm: typeof DEMAND_ALGORITHM; offerings: string[]; hours: number[]; split_at: string;
  interactions: { weekday: boolean; hour: boolean }; coef: number[]; dispersion: number; half_life_days: number; recent_days: number[];
};

function layout(O: number, H: number, inter: DemandParams['interactions']) {
  const off = 1, wd = off + O, hr = wd + 7, ow = hr + H, oh = ow + (inter.weekday ? O * 7 : 0), tr = oh + (inter.hour ? O * H : 0);
  return { off, wd, hr, ow, oh, tr, p: tr + RECENT_DAYS.length };
}

function rowFor(p: Pick<DemandParams, 'offerings' | 'hours' | 'interactions' | 'split_at' | 'recent_days'>, oi: number, d: string, hi: number): SparseRow {
  const O = p.offerings.length, H = p.hours.length;
  const L = layout(O, H, p.interactions);
  const wd = weekdayOf(d);
  const idx = [0, L.off + oi, L.wd + wd, L.hr + hi];
  if (p.interactions.weekday) idx.push(L.ow + oi * 7 + wd);
  if (p.interactions.hour) idx.push(L.oh + oi * H + hi);
  // Recent-level effects: on for the last N days before T and for every date after T (the forecast carries the latest level).
  const before = daysBetween(d, p.split_at);
  p.recent_days.forEach((n, k) => { if (before < n) idx.push(L.tr + k); });
  return { idx, val: idx.map(() => 1) };
}

export function predictDemand(p: DemandParams, o: string, d: string, h: number): number | null {
  const oi = p.offerings.indexOf(o), hi = p.hours.indexOf(h);
  if (oi < 0 || hi < 0) return null;
  const r = rowFor(p, oi, d, hi);
  let eta = 0;
  for (let k = 0; k < r.idx.length; k++) eta += p.coef[r.idx[k]!]! * r.val[k]!;
  return Math.exp(Math.max(-30, Math.min(30, eta)));
}

export function fitDemand(data: DemandData, split: TemporalSplit): DemandParams {
  const O = data.offerings.length, H = data.hours.length;
  const interactions = { weekday: O * 7 <= 350, hour: O * H <= 400 };
  const L = layout(O, H, interactions);
  const base = { offerings: data.offerings, hours: data.hours, interactions, split_at: split.split_at, recent_days: [...RECENT_DAYS] };
  const rows: SparseRow[] = [], y: number[] = [], w: number[] = [];
  const dates = dateRange(split.train_from, split.train_to);
  assertNoLeakage(split, dates, []);
  for (const d of dates) {
    const wt = Math.pow(0.5, daysBetween(d, split.train_to) / HALF_LIFE_DAYS);
    for (let oi = 0; oi < O; oi++) for (let hi = 0; hi < H; hi++) { rows.push(rowFor(base, oi, d, hi)); y.push(yOf(data, data.offerings[oi]!, d, data.hours[hi]!)); w.push(wt); }
  }
  const l2 = Array.from({ length: L.p }, (_, j) => (j === 0 ? 0 : j >= L.ow && j < L.tr ? 4 : 1));
  const mean = y.reduce((a, b) => a + b, 0) / Math.max(1, y.length);
  const fit = fitGlm(rows, y, w, L.p, { family: 'poisson', l2, init: [Math.log(mean + 1e-3)] });
  // Pearson dispersion (≥ 1) for the prediction interval.
  let chi = 0;
  for (let i = 0; i < rows.length; i++) { let eta = 0; const r = rows[i]!; for (let k = 0; k < r.idx.length; k++) eta += fit.coef[r.idx[k]!]! * r.val[k]!; const mu = Math.exp(eta); chi += (y[i]! - mu) ** 2 / Math.max(mu, 1e-6); }
  const dispersion = Math.max(1, Math.min(25, chi / Math.max(1, rows.length - L.p)));
  return { algorithm: DEMAND_ALGORITHM, ...base, coef: fit.coef.map((c) => Math.round(c * 1e8) / 1e8), dispersion: Math.round(dispersion * 1e6) / 1e6, half_life_days: HALF_LIFE_DAYS };
}

/** Evaluates any predictor on the test window: daily totals per offering (WAPE, abs bias) and hourly cells (MAE). */
export function evaluateDemand(data: DemandData, split: TemporalSplit, predict: (o: string, d: string, h: number) => number | null): Evaluation {
  const daily: Array<[number, number]> = [], cells: Array<[number, number]> = [];
  const dates = dateRange(split.test_from, split.test_to);
  assertNoLeakage(split, [], dates);
  for (const o of data.offerings) for (const d of dates) {
    let ys = 0, fs = 0;
    for (const h of data.hours) { const yy = yOf(data, o, d, h); const f = predict(o, d, h) ?? 0; ys += yy; fs += f; cells.push([yy, f]); }
    daily.push([ys, fs]);
  }
  return evaluation('wape', { wape: wape(daily), mae: mae(cells), abs_bias: absBias(daily) }, ['mae', 'abs_bias'], daily.length);
}

/** Trains the candidate and evaluates it and both baselines on the same temporal split. Pure and deterministic. */
export function trainDemand(ds: Pick<CanonicalDataset, 'transactions' | 'offerings' | 'business' | 'meta'>, opts: { testDays?: number } = {}): KindOutcome & { data?: DemandData } {
  const data = demandData(ds);
  if (!data.offerings.length || !data.hours.length) return { status: 'insufficient', reason: 'no_offering_with_enough_sales' };
  let split = temporalSplit(data.from, data.today, opts.testDays ?? DEMAND_TEST_DAYS);
  const trainDays = daysBetween(split.train_from, split.train_to) + 1;
  if (trainDays < 56) return { status: 'insufficient', reason: 'training_window_too_short', detail: { train_days: trainDays } };
  const maxDays = Math.floor(MAX_CELLS / (data.offerings.length * data.hours.length));
  if (trainDays > maxDays) split = { ...split, train_from: addDays(split.train_to, -(maxDays - 1)) };
  const testUnits = data.offerings.reduce((s, o) => s + dateRange(split.test_from, split.test_to).reduce((t, d) => t + data.hours.reduce((u, h) => u + yOf(data, o, d, h), 0), 0), 0);
  if (testUnits < 10) return { status: 'insufficient', reason: 'test_window_too_small', detail: { test_units: testUnits } };
  const params = fitDemand(data, split);
  const candidate = evaluateDemand(data, split, (o, d, h) => predictDemand(params, o, d, h));
  const baselines = DEMAND_BASELINES.map((b) => ({ algorithm: b, ...evaluateDemand(data, split, (o, d, h) => baselinePredict(b, data, o, d, h, split.split_at)) }));
  const baseline = baselines.reduce((best, b) => (b.primary.value < best.primary.value ? b : best));
  const L = layout(data.offerings.length, data.hours.length, params.interactions);
  const explain = [
    ...data.offerings.map((o, i) => ({ feature: `offering:${o}`, effect: Math.exp(params.coef[L.off + i]!) })),
    ...['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map((d, i) => ({ feature: `weekday:${d}`, effect: Math.exp(params.coef[L.wd + i]!) })),
    ...data.hours.map((h, i) => ({ feature: `hour:${h}`, effect: Math.exp(params.coef[L.hr + i]!) })),
    ...RECENT_DAYS.map((n, k) => ({ feature: `recent_level_${n}d`, effect: Math.exp(params.coef[L.tr + k]!) })),
  ].map((e) => ({ ...e, effect: Math.round(e.effect * 1000) / 1000 }));
  return {
    status: 'trained', data,
    model: {
      kind: 'demand_forecast', algorithm: DEMAND_ALGORITHM, split, params, candidate, baseline,
      n_train: (daysBetween(split.train_from, split.train_to) + 1) * data.offerings.length * data.hours.length,
      data_hash: demandHash(data, split), explain,
    },
  };
}

export const demandHash = (data: DemandData, split: TemporalSplit) => stableHash({ split, o: data.offerings, h: data.hours, y: [...data.y.entries()].filter(([k]) => k.split('|')[1]! <= split.test_to).sort() }).slice(0, 32);

/** Re-evaluates a stored (active) version on a new split. Its own T must not be after the new T (else it saw the test data). */
export function evaluateDemandParams(data: DemandData, split: TemporalSplit, p: DemandParams): Evaluation | null {
  if (p.split_at > split.split_at) return null;
  return evaluateDemand(data, split, (o, d, h) => predictDemand(p, o, d, h) ?? baselinePredict('seasonal_naive_4w', data, o, d, h, split.split_at));
}

/** Per-offering dispersion of the seasonal-naive baseline over the last 28 days (one-step backtest), ≥ 1. */
function baselineDispersion(data: DemandData, o: string) {
  let se = 0, sf = 0;
  for (let i = 1; i <= 28; i++) {
    const d = addDays(data.to, -(i - 1));
    if (d < data.from) break;
    let yy = 0, f = 0;
    for (const h of data.hours) { yy += yOf(data, o, d, h); f += seasonalNaive(data, o, d, h, addDays(d, -1)); }
    se += (yy - f) ** 2; sf += f;
  }
  return sf > 0 ? Math.max(1, Math.min(25, se / sf)) : 1;
}

/**
 * Daily forecasts per offering for [today, today + horizon − 1] with a 90%
 * interval (Poisson × dispersion). `params` null ⇒ the labelled baseline.
 */
export function forecastDemand(data: DemandData, horizonDays: number, src: { params: DemandParams; model_version_id: string; version: number } | null): ForecastRow[] {
  const out: ForecastRow[] = [];
  const dates = dateRange(data.today, addDays(data.today, horizonDays - 1));
  const offerings = src ? src.params.offerings : data.offerings;
  for (const o of offerings) {
    const disp = src ? src.params.dispersion : baselineDispersion(data, o);
    for (const d of dates) {
      let mu = 0;
      for (const h of src ? src.params.hours : data.hours) mu += src ? predictDemand(src.params, o, d, h) ?? 0 : seasonalNaive(data, o, d, h, data.to);
      const half = Z90 * Math.sqrt(disp * Math.max(mu, 0));
      const v = round3(mu);
      out.push({
        model_kind: 'demand_forecast', source: src ? 'model' : 'baseline', model_version_id: src?.model_version_id ?? null, version: src?.version ?? null,
        algorithm: src ? DEMAND_ALGORITHM : 'seasonal_naive_4w', subject_key: `offering:${o}|date:${d}`, subject: { offering_id: o, date: d },
        horizon_from: d, horizon_to: d, value: v, low: Math.min(v, round3(Math.max(0, mu - half))), high: Math.max(v, round3(mu + half)), unit: 'count',
      });
    }
  }
  return out;
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;
