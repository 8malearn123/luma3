import { AppError, schedule, withSystem, withTenant, type AuditActor, type Tx } from '../db';
import { analysisConnection } from '../analysis/run';
import { connectorFor } from '../connectors/registry';
import type { CanonicalDataset } from '../contracts/canonical';
import type { CardContent } from '../contracts/opportunity';
import { loadDataset } from '../dataset';
import { scheduleForBusiness } from '../hosts';
import { readPlatformSettings, type LearnedModelSettings } from '../settings/platform';
import { addDays, localDateOf } from '../util/time';
import { demandData, evaluateDemandParams, forecastDemand, trainDemand, type DemandData, type DemandParams } from './demand';
import { eligibility, mae, promotionGate, shadowDecision, wape, absBias, type Eligibility } from './governance';
import { evaluateResponseParams, forecastResponses, trainResponse, type ResponseObs, type ResponseParams } from './response';
import { evaluateReturnParams, featuresAt, forecastReturns, RETURN_HORIZON_DAYS, returnData, trainReturn, type ReturnData, type ReturnParams } from './returns';
import { aggregateBusiness, evaluateSectorParams, sectorSplit, trainSector, type AggregateCell, type SectorParams } from './sector';
import { insertCandidate, insertForecasts, insertShadowPredictions, latestForecasts, recordTrainingRun, transition, versionWithStatus, type ModelVersion, type Scope } from './store';
import { MODEL_KINDS, type Evaluation, type ForecastRow, type GateResult, type KindOutcome, type ModelKind, type TemporalSplit } from './types';

/**
 * Phase 6 orchestration (docs/LOOM_CORE.md §24): training (per business, on
 * the platform cadence), the promotion gate, the shadow period evaluated on
 * realised data, activation, one-click rollback, forecasts and the sector
 * models trained only on consenting businesses' aggregates.
 */
export const TRAIN_JOB = 'loom.train';
export const SHADOW_JOB = 'loom.shadow_eval';
export const FORECAST_JOB = 'loom.forecast_refresh';
export const SECTOR_TRAIN_JOB = 'loom.sector_train';
export const DEMAND_HORIZON_DAYS = 14;
const SYSTEM: AuditActor = { userId: null, kind: 'system' };

export type DatasetLoader = (businessId: string, now: Date) => Promise<CanonicalDataset>;
export const defaultDatasetLoader: DatasetLoader = async (businessId, now) => {
  const conn = await withTenant(businessId, (trx) => analysisConnection(trx, businessId));
  return loadDataset(connectorFor(conn.kind), { ...conn, as_of: now });
};

export async function modelSettings() {
  return withSystem('loom: model settings', async (trx) => {
    const p = await readPlatformSettings(trx);
    return { ...p.learned_models, thresholds: p.learned_model_thresholds };
  });
}
type Settings = LearnedModelSettings & { thresholds: { min_days: number; min_completed_transactions: number } };

/** Measured outcomes (phase 5) as intervention responses: relative change of the primary metric, never from an `insufficient` measurement. */
export async function loadResponses(trx: Tx, businessId: string): Promise<ResponseObs[]> {
  const rows = await trx.selectFrom('loom.outcomes as o').innerJoin('loom.initiatives as i', 'i.id', 'o.initiative_id')
    .select(['o.created_at', 'o.primary_metrics', 'o.measurement_quality', 'i.original_proposal', 'i.category'])
    .where('o.business_id', '=', businessId).where('o.measurement_quality', '<>', 'insufficient').orderBy('o.created_at').execute();
  const out: ResponseObs[] = [];
  for (const r of rows) {
    const m = (r.primary_metrics as Array<{ estimate: number | null; change: number | null }>)[0];
    const response = m?.estimate ?? m?.change ?? null;
    const iv = (r.original_proposal as CardContent | null)?.recommended_action?.intervention_id;
    if (response === null || !Number.isFinite(response) || !iv) continue;
    out.push({ at: r.created_at.toISOString().slice(0, 10), intervention_id: iv, category: r.category, response });
  }
  return out;
}

/** Per-kind data the trainers and the shadow / forecast steps share. */
type KindContext = { demand: DemandData; returns: ReturnData; responses: ResponseObs[]; today: string; offeringIds: string[] };
function contextOf(ds: CanonicalDataset, responses: ResponseObs[]): KindContext {
  return { demand: demandData(ds), returns: returnData(ds), responses, today: ds.meta.today, offeringIds: ds.offerings.filter((o) => o.status === 'active').map((o) => o.id).sort() };
}

/** Re-evaluates a stored (active) version on the candidate's split; null when it was trained past T (not comparable). */
function evaluateStored(kind: ModelKind, v: ModelVersion, kc: KindContext, split: TemporalSplit): Evaluation | null {
  const params = v.params as unknown;
  if (kind === 'demand_forecast') return evaluateDemandParams(kc.demand, split, params as DemandParams);
  if (kind === 'return_probability') return evaluateReturnParams(kc.returns, split, params as ReturnParams);
  return evaluateResponseParams(kc.responses, split, params as ResponseParams);
}

const shadowLength = (kind: ModelKind, days: number) => (kind === 'return_probability' ? Math.max(days, RETURN_HORIZON_DAYS + 1) : kind === 'intervention_response' ? Math.max(days, 30) : days);

export type TrainSummary = { status: 'disabled' | 'ineligible' | 'trained'; eligibility?: Eligibility; kinds: Partial<Record<ModelKind, { status: string; reason?: string; version?: number; gate?: GateResult; shadow?: boolean }>> };

/**
 * Trains every kind for one business. Below the platform thresholds nothing is
 * trained (baseline only) and the run records why. Idempotent per data hash.
 */
export async function trainBusiness(businessId: string, opts: { now?: Date; dataset?: CanonicalDataset; actor?: AuditActor; trigger?: 'schedule' | 'manual' | 'test' } = {}): Promise<TrainSummary> {
  try {
    return await trainBusinessInner(businessId, opts);
  } catch (e) {
    // A failed run is recorded (the UI says so) and the business keeps what it had (active version or baseline).
    await withTenant(businessId, (trx) => recordTrainingRun(trx, { businessId, status: 'failed', summary: { error: (e as Error).message.slice(0, 300) }, trigger: opts.trigger ?? 'schedule', actor: opts.actor ?? SYSTEM })).catch(() => undefined);
    throw e;
  }
}

async function trainBusinessInner(businessId: string, opts: { now?: Date; dataset?: CanonicalDataset; actor?: AuditActor; trigger?: 'schedule' | 'manual' | 'test' }): Promise<TrainSummary> {
  const now = opts.now ?? new Date();
  const actor = opts.actor ?? SYSTEM;
  const trigger = opts.trigger ?? 'schedule';
  const settings = await modelSettings();
  if (!settings.enabled) {
    await withTenant(businessId, (trx) => recordTrainingRun(trx, { businessId, status: 'disabled', trigger, actor }));
    return { status: 'disabled', kinds: {} };
  }
  const ds = opts.dataset ?? await defaultDatasetLoader(businessId, now);
  const elig = eligibility(ds, settings.thresholds);
  if (!elig.eligible) {
    await withTenant(businessId, (trx) => recordTrainingRun(trx, { businessId, status: 'ineligible', eligibility: elig, data_version: ds.meta.data_version, trigger, actor }));
    return { status: 'ineligible', eligibility: elig, kinds: {} };
  }
  const responses = await withTenant(businessId, (trx) => loadResponses(trx, businessId));
  const kc = contextOf(ds, responses);
  const outcomes: Record<ModelKind, KindOutcome> = {
    demand_forecast: trainDemand(ds),
    return_probability: trainReturn(ds),
    intervention_response: trainResponse(responses, { minOutcomes: settings.min_measured_outcomes }),
  };
  const summary: TrainSummary = { status: 'trained', eligibility: elig, kinds: {} };
  for (const kind of MODEL_KINDS) {
    const o = outcomes[kind];
    if (o.status !== 'trained') { summary.kinds[kind] = { status: 'baseline_only', reason: o.reason }; continue; }
    const m = o.model;
    summary.kinds[kind] = await withTenant(businessId, async (trx) => {
      const dup = await trx.selectFrom('loom.model_versions').select(['version']).where('business_id', '=', businessId).where('model_kind', '=', kind)
        .where('algorithm', '=', m.algorithm).where('data_hash', '=', m.data_hash).executeTakeFirst();
      if (dup) return { status: 'skipped', reason: 'same_data', version: dup.version };
      const active = await versionWithStatus(trx, { businessId }, kind, 'active');
      const activeEval = active ? evaluateStored(kind, active, kc, m.split) : null;
      let gate = promotionGate({ candidate: m.candidate, baseline: m.baseline, active: activeEval, margin: settings.promotion_margin[kind], guardrail_tolerance: settings.guardrail_tolerance });
      if (active && !activeEval) gate = { ...gate, passed: false, reasons: [...gate.reasons, 'active_not_comparable'] };
      const cand = await insertCandidate(trx, { businessId }, m, { data_version: ds.meta.data_version, active: active && activeEval ? { ...activeEval, version_id: active.id, version: active.version } : null, gate, actor });
      if (!gate.passed) {
        await transition(trx, cand, 'retired', { actor, event: 'retired', reason: 'gate_failed', retired_reason: 'gate_failed', data: { reasons: gate.reasons } });
        return { status: 'gate_failed', version: cand.version, gate };
      }
      if (!settings.auto_promote) return { status: 'candidate', version: cand.version, gate };
      await startShadow(trx, businessId, cand, kc, settings, actor, now);
      return { status: 'shadow', version: cand.version, gate, shadow: true };
    });
  }
  await withTenant(businessId, (trx) => recordTrainingRun(trx, { businessId, status: 'trained', eligibility: elig, summary: summary.kinds, data_version: ds.meta.data_version, trigger, actor }));
  return summary;
}

/** Predictions of a version (or the baseline when null) per subject for the shadow comparison. */
function shadowRows(kind: ModelKind, v: ModelVersion | null, kc: KindContext, days: number): Map<string, { from: string; to: string; value: number; algorithm: string }> {
  const out = new Map<string, { from: string; to: string; value: number; algorithm: string }>();
  const src = v ? { params: v.params as never, model_version_id: v.id, version: v.version } : null;
  let rows: ForecastRow[];
  if (kind === 'demand_forecast') {
    rows = forecastDemand(kc.demand, days, src);
  } else if (kind === 'return_probability') rows = forecastReturns(kc.returns, src, kc.offeringIds);
  else rows = forecastResponses(kc.responses, kc.today, src);
  for (const r of rows) out.set(r.subject_key, { from: r.horizon_from, to: r.horizon_to, value: r.value, algorithm: r.algorithm });
  return out;
}

async function startShadow(trx: Tx, businessId: string, cand: ModelVersion, kc: KindContext, settings: Settings, actor: AuditActor, now: Date) {
  const kind = cand.model_kind as ModelKind;
  const current = await versionWithStatus(trx, { businessId }, kind, 'shadow');
  if (current) await transition(trx, current, 'retired', { actor, event: 'retired', reason: 'superseded', retired_reason: 'superseded', data: { by_version: cand.version } });
  const days = shadowLength(kind, settings.shadow_days);
  const shadow = await transition(trx, cand, 'shadow', { actor, event: 'shadow_started', reason: 'gate_passed', shadow_until: new Date(now.getTime() + days * 86_400_000), data: { days } });
  const active = await versionWithStatus(trx, { businessId }, kind, 'active');
  const mine = shadowRows(kind, shadow, kc, days);
  const ref = shadowRows(kind, active ?? null, kc, days);
  const rows = [...mine.entries()].filter(([k]) => ref.has(k)).map(([k, s]) => ({ subject_key: k, from: s.from, to: s.to, shadow: s.value, reference: ref.get(k)!.value }));
  const refAlgo = [...ref.values()][0]?.algorithm ?? 'baseline';
  if (rows.length) await insertShadowPredictions(trx, businessId, shadow, { source: active ? 'active' : 'baseline', version_id: active?.id ?? null, algorithm: refAlgo }, rows);
  return shadow;
}

async function activate(trx: Tx, businessId: string, v: ModelVersion, actor: AuditActor, reason: string) {
  const kind = v.model_kind as ModelKind;
  const current = await versionWithStatus(trx, { businessId }, kind, 'active');
  if (current) await transition(trx, current, 'retired', { actor, event: 'retired', reason: 'replaced', retired_reason: 'replaced', data: { by_version: v.version } });
  return transition(trx, v, 'active', { actor, event: 'activated', reason });
}

/** Realised value per shadow subject (only fully elapsed periods). */
function realised(kind: ModelKind, ds: CanonicalDataset, kc: KindContext, preds: Array<{ subject_key: string; period_from: string; period_to: string }>, shadowFrom: Date) {
  const out = new Map<string, number>();
  const last = addDays(ds.meta.today, -1);
  const tz = ds.business.timezone;
  if (kind === 'demand_forecast') {
    const units = new Map<string, number>();
    for (const t of ds.transactions) if (t.status === 'fulfilled') for (const l of t.lines) { const k = `offering:${l.offering_id}|date:${localDateOf(l.starts_at, tz)}`; units.set(k, (units.get(k) ?? 0) + l.qty); }
    for (const p of preds) if (p.period_to <= last) out.set(p.subject_key, units.get(p.subject_key) ?? 0);
  } else if (kind === 'return_probability') {
    for (const p of preds) {
      if (p.period_to > last) continue;
      const ref = addDays(p.period_from, -1);
      const cohort = p.subject_key.replace(/^customers:/, '');
      let n = 0;
      for (const [, vs] of kc.returns.visits) {
        if (!featuresAt(vs, ref)) continue;
        if (cohort !== 'all' && !vs.some((v) => v.d <= ref && v.offerings.includes(cohort.replace(/^offering:/, '')))) continue;
        if (vs.some((v) => v.d >= p.period_from && v.d <= p.period_to)) n++;
      }
      out.set(p.subject_key, n);
    }
  } else {
    const since = shadowFrom.toISOString().slice(0, 10);
    const by = new Map<string, number[]>();
    for (const o of kc.responses) if (o.at >= since) { const k = `intervention:${o.intervention_id}|category:${o.category}`; by.set(k, [...(by.get(k) ?? []), o.response]); }
    for (const p of preds) { const xs = by.get(p.subject_key); if (xs?.length) out.set(p.subject_key, xs.reduce((a, b) => a + b, 0) / xs.length); }
  }
  return out;
}

/** Evaluates due shadow versions on realised data; passing ones become active (auto_promote), failing ones are retired. */
export async function evaluateShadows(businessId: string, opts: { now?: Date; dataset?: CanonicalDataset; actor?: AuditActor } = {}) {
  const now = opts.now ?? new Date();
  const actor = opts.actor ?? SYSTEM;
  const settings = await modelSettings();
  const due = await withTenant(businessId, (trx) => trx.selectFrom('loom.model_versions').selectAll().where('business_id', '=', businessId).where('status', '=', 'shadow').where('shadow_until', '<=', now).execute());
  if (!due.length) return { evaluated: 0, activated: 0, retired: 0 };
  const ds = opts.dataset ?? await defaultDatasetLoader(businessId, now);
  const kc = contextOf(ds, await withTenant(businessId, (trx) => loadResponses(trx, businessId)));
  let activated = 0, retired = 0;
  for (const v of due) {
    const kind = v.model_kind as ModelKind;
    await withTenant(businessId, async (trx) => {
      const preds = await trx.selectFrom('loom.shadow_predictions').selectAll().where('business_id', '=', businessId).where('model_version_id', '=', v.id).execute();
      const real = realised(kind, ds, kc, preds, v.shadow_from ?? now);
      const sPairs: Array<[number, number]> = [], rPairs: Array<[number, number]> = [];
      for (const p of preds) { const y = real.get(p.subject_key); if (y === undefined) continue; sPairs.push([y, p.shadow_value]); rPairs.push([y, p.reference_value]); }
      const metric = kind === 'intervention_response' ? mae : wape;
      const bias = kind === 'intervention_response' ? (xs: Array<[number, number]>) => Math.abs(xs.reduce((s, [y, f]) => s + f - y, 0) / Math.max(1, xs.length)) : absBias;
      const minN = kind === 'demand_forecast' ? 7 : kind === 'return_probability' ? 1 : 3;
      const sPrimary = metric(sPairs), rPrimary = metric(rPairs);
      const decision = shadowDecision({
        shadow: { primary: Number.isFinite(sPrimary) ? sPrimary : Infinity, guardrails: { abs_bias: finite(bias(sPairs)) } },
        reference: { primary: Number.isFinite(rPrimary) ? rPrimary : 0, guardrails: { abs_bias: finite(bias(rPairs)) } },
        guardrail_tolerance: settings.guardrail_tolerance, n: sPairs.length, min_n: minN,
      });
      const result = { evaluated_at: now.toISOString(), n: sPairs.length, metric: kind === 'intervention_response' ? 'mae' : 'wape', shadow: round(sPrimary), reference: round(rPrimary), reference_source: preds[0]?.reference_source ?? null, ...decision };
      const pendingTooLong = decision.pending && now.getTime() > (v.shadow_until?.getTime() ?? 0) + 60 * 86_400_000;
      await trx.updateTable('loom.model_versions').set({ shadow_result: JSON.stringify(result) }).where('id', '=', v.id).execute();
      await trx.insertInto('loom.model_events').values({ business_id: businessId, model_version_id: v.id, event: 'shadow_evaluated', from_status: 'shadow', to_status: 'shadow', reason: decision.passed ? 'passed' : decision.pending ? 'pending' : 'failed', data: JSON.stringify(result), actor_id: actor.userId }).execute();
      if (decision.passed && settings.auto_promote) { await activate(trx, businessId, v, actor, 'shadow_passed'); activated++; }
      else if ((!decision.passed && !decision.pending) || pendingTooLong) { await transition(trx, v, 'retired', { actor, event: 'retired', reason: 'shadow_failed', retired_reason: 'shadow_failed', data: { reasons: decision.reasons } }); retired++; }
    });
  }
  if (activated) await refreshForecasts(businessId, { now, dataset: ds });
  return { evaluated: due.length, activated, retired };
}

const finite = (x: number) => (Number.isFinite(x) ? x : 0);
const round = (x: number) => (Number.isFinite(x) ? Math.round(x * 1e6) / 1e6 : null);

/**
 * Forecasts for a business: from the ACTIVE version of each kind, else the
 * labelled baseline. Stored append-only (one batch per kind) and returned.
 * Nothing when the platform switch is off.
 */
export async function refreshForecasts(businessId: string, opts: { now?: Date; dataset?: CanonicalDataset; analysisId?: string | null } = {}): Promise<ForecastRow[]> {
  const settings = await modelSettings();
  if (!settings.enabled) return [];
  const ds = opts.dataset ?? await defaultDatasetLoader(businessId, opts.now ?? new Date());
  return withTenant(businessId, async (trx) => {
    const kc = contextOf(ds, await loadResponses(trx, businessId));
    const all: ForecastRow[] = [];
    for (const kind of MODEL_KINDS) {
      const v = await versionWithStatus(trx, { businessId }, kind, 'active');
      const src = v ? { params: v.params as never, model_version_id: v.id, version: v.version } : null;
      const rows = kind === 'demand_forecast' ? forecastDemand(kc.demand, DEMAND_HORIZON_DAYS, src)
        : kind === 'return_probability' ? (kc.returns.visits.size ? forecastReturns(kc.returns, src, kc.offeringIds) : [])
          : forecastResponses(kc.responses, kc.today, src);
      if (rows.length) await insertForecasts(trx, businessId, rows, { data_version: ds.meta.data_version, analysis_id: opts.analysisId ?? null });
      all.push(...rows);
    }
    return all;
  });
}

/** For the analysis pipeline: forecasts never break an analysis (errors ⇒ no forecasts). */
export async function forecastsForAnalysis(businessId: string, ds: CanonicalDataset, analysisId: string): Promise<ForecastRow[]> {
  try {
    return await refreshForecasts(businessId, { dataset: ds, analysisId });
  } catch {
    return [];
  }
}

// ── Manual actions (API) ─────────────────────────────────────────────────────
/**
 * Manual promotion never bypasses a gate: a candidate goes to shadow only if
 * its promotion gate passed; a shadow version goes active only once its
 * shadow evaluation passed.
 */
export async function promoteVersion(businessId: string, versionId: string, actor: AuditActor, opts: { now?: Date; dataset?: CanonicalDataset } = {}) {
  const now = opts.now ?? new Date();
  const v = await withTenant(businessId, (trx) => trx.selectFrom('loom.model_versions').selectAll().where('business_id', '=', businessId).where('id', '=', versionId).executeTakeFirst());
  if (!v) throw new AppError(404, 'not_found', 'Model version not found');
  if (v.status === 'candidate') {
    if (!(v.gate as GateResult).passed) throw new AppError(409, 'gate_not_passed', 'The candidate did not pass the promotion gate.', { reasons: (v.gate as GateResult).reasons });
    const settings = await modelSettings();
    const ds = opts.dataset ?? await defaultDatasetLoader(businessId, now);
    const kc = contextOf(ds, await withTenant(businessId, (trx) => loadResponses(trx, businessId)));
    return withTenant(businessId, (trx) => startShadow(trx, businessId, v, kc, settings, actor, now));
  }
  if (v.status === 'shadow') {
    const r = v.shadow_result as { passed?: boolean } | null;
    if (!r?.passed) throw new AppError(409, 'shadow_not_passed', 'The shadow period has not been evaluated as passed yet.');
    const row = await withTenant(businessId, (trx) => activate(trx, businessId, v, actor, 'manual_promotion'));
    await refreshForecasts(businessId, { now, dataset: opts.dataset }).catch(() => []);
    return row;
  }
  throw new AppError(409, 'invalid_status', `A ${v.status} version cannot be promoted.`);
}

/**
 * One-click rollback: retire the active version and restore the version it
 * replaced (a version retired by a rollback is never restored again), else
 * fall back to the baseline.
 */
export async function rollback(businessId: string, kind: ModelKind, actor: AuditActor) {
  const r = await withTenant(businessId, async (trx) => {
    const active = await versionWithStatus(trx, { businessId }, kind, 'active');
    if (!active) throw new AppError(409, 'no_active_model', 'There is no active model to roll back.');
    const prev = await trx.selectFrom('loom.model_versions').selectAll().where('business_id', '=', businessId).where('model_kind', '=', kind)
      .where('status', '=', 'retired').where('promoted_at', 'is not', null).where('retired_reason', '=', 'replaced').where('id', '!=', active.id).orderBy('promoted_at', 'desc').executeTakeFirst();
    await transition(trx, active, 'retired', { actor, event: 'rollback', reason: 'rollback', retired_reason: 'rollback', data: { restored_version: prev?.version ?? null } });
    if (prev) await transition(trx, prev, 'active', { actor, event: 'restored', reason: 'rollback', data: { from_version: active.version } });
    await scheduleForBusiness(trx, businessId, FORECAST_JOB, {}, { dedupeKey: `loom_forecast:${businessId}:${Date.now()}`, maxAttempts: 2 });
    return { retired_version: active.version, restored_version: prev?.version ?? null, fallback: prev ? 'previous_version' : 'baseline' };
  });
  return r;
}

export async function requestTraining(businessId: string, actor: AuditActor) {
  await withTenant(businessId, (trx) => scheduleForBusiness(trx, businessId, TRAIN_JOB, { trigger: 'manual', actor_id: actor.userId }, { dedupeKey: `loom_train:${businessId}:manual:${new Date().toISOString().slice(0, 16)}`, maxAttempts: 2 }));
  return { queued: true };
}

// ── Scheduling (periodic) ────────────────────────────────────────────────────
/** Retraining on the platform cadence, due shadow evaluations and a daily forecast refresh, for businesses that use Loom. */
export async function scheduleModelWork(now = new Date()) {
  const settings = await modelSettings();
  if (!settings.enabled) return { train: 0, shadow: 0, forecast: 0 };
  const since = new Date(now.getTime() - 30 * 86_400_000);
  const businesses = await withSystem('loom: model work', async (trx) => {
    const used = await trx.selectFrom('loom.analyses').select('business_id').distinct().where('status', '=', 'succeeded').where('created_at', '>', since).execute();
    const lastRun = await trx.selectFrom('loom.model_training_runs').select(['business_id', (eb) => eb.fn.max('created_at').as('at')]).where('business_id', 'is not', null).groupBy('business_id').execute();
    const shadows = await trx.selectFrom('loom.model_versions').select('business_id').distinct().where('status', '=', 'shadow').where('shadow_until', '<=', now).where('business_id', 'is not', null).execute();
    const lastFc = await trx.selectFrom('loom.forecasts').select(['business_id', (eb) => eb.fn.max('created_at').as('at')]).groupBy('business_id').execute();
    return { used: used.map((u) => u.business_id), lastRun: new Map(lastRun.map((r) => [r.business_id!, r.at as Date])), shadows: shadows.map((s) => s.business_id!), lastFc: new Map(lastFc.map((r) => [r.business_id, r.at as Date])) };
  });
  const day = now.toISOString().slice(0, 10);
  let train = 0, shadow = 0, forecast = 0;
  for (const b of businesses.used) {
    const last = businesses.lastRun.get(b);
    if (!last || now.getTime() - last.getTime() >= settings.retrain_days * 86_400_000) {
      await withTenant(b, (trx) => scheduleForBusiness(trx, b, TRAIN_JOB, { trigger: 'schedule' }, { dedupeKey: `loom_train:${b}:${day}`, maxAttempts: 2 })); train++;
    }
    const fc = businesses.lastFc.get(b);
    if (!fc || now.getTime() - fc.getTime() >= 86_400_000) { await withTenant(b, (trx) => scheduleForBusiness(trx, b, FORECAST_JOB, {}, { dedupeKey: `loom_forecast:${b}:${day}`, maxAttempts: 2 })); forecast++; }
  }
  for (const b of businesses.shadows) { await withTenant(b, (trx) => scheduleForBusiness(trx, b, SHADOW_JOB, {}, { dedupeKey: `loom_shadow:${b}:${day}`, maxAttempts: 2 })); shadow++; }
  if (settings.sector_models) {
    const week = `${now.getUTCFullYear()}-${Math.floor((now.getTime() / 86_400_000 + 3) / 7)}`;
    await withSystem('loom: schedule sector training', (trx) => schedule(trx, SECTOR_TRAIN_JOB, {}, { tenantId: null, dedupeKey: `loom_sector_train:${week}`, maxAttempts: 2 }));
  }
  return { train, shadow, forecast };
}

// ── Sector models (consenting businesses only) ──────────────────────────────
/** Businesses whose CURRENT explicit shared-training consent is true (default false; no fact ⇒ excluded). */
export async function consentingBusinesses(sector: string): Promise<string[]> {
  return withSystem('loom: consenting businesses for sector training', async (trx) => {
    const rows = await trx.selectFrom('loom.business_profile_facts as f').leftJoin('loom.businesses as b', 'b.id', 'f.business_id').select(['f.business_id', 'f.value', 'b.sector_pack'])
      .where('f.key', '=', 'consent.shared_training').where('f.kind', '=', 'explicit').where('f.superseded_by', 'is', null).execute();
    // LUMA tenants without a loom.businesses row use the default pack.
    return [...new Set(rows.filter((r) => r.value === true && (r.sector_pack ?? 'beauty') === sector).map((r) => r.business_id))].sort();
  });
}

export async function trainSectorModel(sector: string, opts: { now?: Date; loader?: DatasetLoader; actor?: AuditActor; trigger?: 'schedule' | 'manual' | 'test' } = {}) {
  const now = opts.now ?? new Date();
  const actor = opts.actor ?? SYSTEM;
  const trigger = opts.trigger ?? 'schedule';
  const settings = await modelSettings();
  if (!settings.enabled || !settings.sector_models) {
    await withSystem('loom: sector training disabled', (trx) => recordTrainingRun(trx, { businessId: null, sector, status: 'disabled', trigger, actor }));
    return { status: 'disabled' as const };
  }
  const loader = opts.loader ?? defaultDatasetLoader;
  const ids = await consentingBusinesses(sector);
  const today = new Date(now).toISOString().slice(0, 10);
  const split = sectorSplit(today);
  // Each business is reduced to aggregate counts here; ids are not kept with the cells.
  const contributions: AggregateCell[][] = [];
  for (const id of ids) {
    try { contributions.push(aggregateBusiness(returnData(await loader(id, now)), split.split_at)); } catch { /* an unavailable business is skipped */ }
  }
  const o = trainSector(contributions, today);
  const scope: Scope = { businessId: null, sector };
  return withSystem('loom: sector model', async (trx) => {
    if (o.status !== 'trained') {
      await recordTrainingRun(trx, { businessId: null, sector, status: 'skipped', summary: { reason: o.reason, ...o.detail }, trigger, actor });
      return { status: 'insufficient' as const, reason: o.reason, contributors: o.contributors };
    }
    const m = o.model;
    const active = await versionWithStatus(trx, scope, 'return_probability', 'active');
    const activeEval = active ? evaluateSectorParams(contributions, m.split, active.params as unknown as SectorParams) : null;
    let gate = promotionGate({ candidate: m.candidate, baseline: m.baseline, active: activeEval, margin: settings.promotion_margin.return_probability, guardrail_tolerance: settings.guardrail_tolerance });
    if (active && !activeEval) gate = { ...gate, passed: false, reasons: [...gate.reasons, 'active_not_comparable'] };
    const cand = await insertCandidate(trx, scope, m, { data_version: null, active: active && activeEval ? { ...activeEval, version_id: active.id, version: active.version } : null, gate, actor, contributors: o.contributors });
    if (!gate.passed) await transition(trx, cand, 'retired', { actor, event: 'retired', reason: 'gate_failed', retired_reason: 'gate_failed', data: { reasons: gate.reasons } });
    else {
      const cur = await versionWithStatus(trx, scope, 'return_probability', 'shadow');
      if (cur) await transition(trx, cur, 'retired', { actor, event: 'retired', reason: 'superseded', retired_reason: 'superseded' });
      await transition(trx, cand, 'shadow', { actor, event: 'shadow_started', reason: 'gate_passed', shadow_until: new Date(now.getTime() + settings.shadow_days * 86_400_000) });
    }
    await recordTrainingRun(trx, { businessId: null, sector, status: 'trained', summary: { version: cand.version, gate: gate.passed, contributors: o.contributors }, trigger, actor });
    return { status: gate.passed ? 'shadow' as const : 'gate_failed' as const, version: cand.version, contributors: o.contributors, gate };
  });
}

/** Platform owner: a sector shadow version becomes active once its shadow period has elapsed (sector models serve no business yet). */
export async function promoteSectorVersion(versionId: string, actor: AuditActor, now = new Date()) {
  return withSystem('loom: promote sector model', async (trx) => {
    const v = await trx.selectFrom('loom.model_versions').selectAll().where('id', '=', versionId).where('business_id', 'is', null).executeTakeFirst();
    if (!v) throw new AppError(404, 'not_found', 'Model version not found');
    if (v.status !== 'shadow') throw new AppError(409, 'invalid_status', `A ${v.status} version cannot be promoted.`);
    if (!v.shadow_until || v.shadow_until > now) throw new AppError(409, 'shadow_in_progress', 'The shadow period has not ended.');
    const scope: Scope = { businessId: null, sector: v.sector! };
    const cur = await versionWithStatus(trx, scope, v.model_kind as ModelKind, 'active');
    if (cur) await transition(trx, cur, 'retired', { actor, event: 'retired', reason: 'replaced', retired_reason: 'replaced' });
    return transition(trx, v, 'active', { actor, event: 'activated', reason: 'manual_promotion' });
  });
}

export async function rollbackSector(sector: string, kind: ModelKind, actor: AuditActor) {
  return withSystem('loom: rollback sector model', async (trx) => {
    const scope: Scope = { businessId: null, sector };
    const active = await versionWithStatus(trx, scope, kind, 'active');
    if (!active) throw new AppError(409, 'no_active_model', 'There is no active model to roll back.');
    const prev = await trx.selectFrom('loom.model_versions').selectAll().where('business_id', 'is', null).where('sector', '=', sector).where('model_kind', '=', kind)
      .where('status', '=', 'retired').where('promoted_at', 'is not', null).where('retired_reason', '=', 'replaced').where('id', '!=', active.id).orderBy('promoted_at', 'desc').executeTakeFirst();
    await transition(trx, active, 'retired', { actor, event: 'rollback', reason: 'rollback', retired_reason: 'rollback' });
    if (prev) await transition(trx, prev, 'active', { actor, event: 'restored', reason: 'rollback' });
    return { retired_version: active.version, restored_version: prev?.version ?? null };
  });
}

export { latestForecasts };
