import type { Localized } from '../util/text';
import { round, stableHash } from '../util/text';
import type { MetricContext } from './context';

/**
 * Metrics registry (§6.3). Each metric is defined ONCE in code with
 * defineMetric(); the definition (without compute) is mirrored to
 * loom.metric_definitions under (key, version). Change the formula ⇒ bump
 * the version.
 */
export type MetricUnit = 'count' | 'ratio' | 'minor' | 'minutes' | 'rating' | 'days' | 'units';
export type MetricGrain = 'business' | 'offering' | 'resource' | 'slot' | 'day' | 'item' | 'channel' | 'source' | 'campaign';
export type QualityDomain = 'sales' | 'customers' | 'capacity' | 'economics' | 'inventory' | 'demand' | 'reviews' | 'campaigns';

/** One computed point; `n` is the sample the value rests on. */
export type MetricPoint = { grain_ref: string; value: number | null; n: number; missing_input?: boolean };

export type MetricDefinition = {
  key: string;
  version: number;
  label: Localized;
  unit: MetricUnit;
  grain: MetricGrain[];
  /** ISO-8601 duration of the window (P90D, P28D, P14D-forward, …). */
  window: string;
  formula: string;
  requires: string[];
  /** Below this sample the value is withheld (status insufficient_sample). */
  min_sample: number;
  sectors: string[];
  domain: QualityDomain;
  compute: (ctx: MetricContext) => MetricPoint[];
};

export type MetricStatus = 'ok' | 'insufficient_sample' | 'missing_input';
export type MetricValue = { key: string; version: number; grain_ref: string; value: number | null; n: number; status: MetricStatus; unit: MetricUnit };

const registry = new Map<string, MetricDefinition>();

export function defineMetric(def: MetricDefinition): MetricDefinition {
  if (!/^[a-z]+(\.[a-z0-9_]+)+$/.test(def.key)) throw new Error(`invalid metric key ${def.key}`);
  const prev = registry.get(def.key);
  if (prev && prev.version !== def.version) throw new Error(`metric ${def.key} defined twice with different versions`);
  registry.set(def.key, def);
  return def;
}

export const metricDefinitions = () => [...registry.values()];
export const metricDefinition = (key: string) => registry.get(key);

/** The persisted part of a definition and a hash that detects edits without a version bump. */
export function definitionRecord(d: MetricDefinition) {
  const rec = { key: d.key, version: d.version, label_ar: d.label.ar, label_en: d.label.en, unit: d.unit, grain: d.grain, time_window: d.window,
    formula: d.formula, requires: d.requires, min_sample: d.min_sample, sectors: d.sectors };
  return { ...rec, definition_hash: stableHash(rec).slice(0, 32) };
}

export class MetricSet {
  private byKey = new Map<string, Map<string, MetricValue>>();
  constructor(readonly values: MetricValue[]) {
    for (const v of values) { const m = this.byKey.get(v.key) ?? new Map(); m.set(v.grain_ref, v); this.byKey.set(v.key, m); }
  }
  get(key: string, grainRef = 'business'): MetricValue | undefined { return this.byKey.get(key)?.get(grainRef); }
  value(key: string, grainRef = 'business'): number | null { return this.get(key, grainRef)?.value ?? null; }
  all(key: string): MetricValue[] { return [...(this.byKey.get(key)?.values() ?? [])]; }
}

/** Computes every registered metric enabled for the sector. Values below min_sample are withheld. */
export function computeMetrics(ctx: MetricContext, opts: { sector?: string; only?: string[] } = {}): MetricSet {
  const sector = opts.sector ?? ctx.ds.business.sector;
  const out: MetricValue[] = [];
  for (const d of metricDefinitions()) {
    if (opts.only && !opts.only.includes(d.key)) continue;
    if (!d.sectors.includes('*') && !d.sectors.includes(sector)) continue;
    for (const p of d.compute(ctx)) {
      const status: MetricStatus = p.missing_input ? 'missing_input' : p.n < d.min_sample ? 'insufficient_sample' : 'ok';
      out.push({ key: d.key, version: d.version, grain_ref: p.grain_ref, n: p.n, unit: d.unit, status,
        value: status === 'ok' && p.value !== null && Number.isFinite(p.value) ? round(p.value) : null });
    }
  }
  return new MetricSet(out);
}
