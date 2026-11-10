import { randomUUID } from 'node:crypto';
import type { ExpressionBuilder, Selectable } from 'kysely';
import type { DB, LoomModelVersions } from '@/server/db/schema.generated';
import { AppError, type AuditActor, type Tx } from '../db';
import { loomAudit } from '../hosts';
import type { Evaluation, ForecastRow, GateResult, ModelKind, ModelStatus, TrainedModel } from './types';

/**
 * Storage of phase 6 (schema loom, migration 0740): the model registry with
 * audited status transitions, training runs, forecasts and shadow
 * predictions. Business models live in tenant scope; sector models
 * (business_id null) only in system scope.
 */
export type ModelVersion = Selectable<LoomModelVersions>;
export type Scope = { businessId: string; sector?: null } | { businessId: null; sector: string };

const inScope = (s: Scope) => (eb: ExpressionBuilder<DB, 'loom.model_versions'>) =>
  s.businessId ? eb('business_id', '=', s.businessId) : eb.and([eb('business_id', 'is', null), eb('sector', '=', s.sector!)]);

export async function versionsOf(trx: Tx, s: Scope, kind?: ModelKind, limit = 50): Promise<ModelVersion[]> {
  let q = trx.selectFrom('loom.model_versions').selectAll().where(inScope(s));
  if (kind) q = q.where('model_kind', '=', kind);
  return q.orderBy('created_at', 'desc').orderBy('version', 'desc').limit(limit).execute();
}

export async function versionWithStatus(trx: Tx, s: Scope, kind: ModelKind, status: ModelStatus): Promise<ModelVersion | undefined> {
  return trx.selectFrom('loom.model_versions').selectAll().where(inScope(s)).where('model_kind', '=', kind).where('status', '=', status).executeTakeFirst();
}

export async function insertCandidate(trx: Tx, s: Scope, m: TrainedModel, extra: { data_version: string | null; active: (Evaluation & { version_id: string; version: number }) | null; gate: GateResult; actor: AuditActor; contributors?: number }) {
  const last = await trx.selectFrom('loom.model_versions').select((eb) => eb.fn.max('version').as('v')).where(inScope(s)).where('model_kind', '=', m.kind).executeTakeFirst();
  const version = Number(last?.v ?? 0) + 1;
  const metrics = {
    primary_metric: m.candidate.primary.key,
    candidate: m.candidate, baseline: m.baseline, active: extra.active,
    n_train: m.n_train, n_test: m.candidate.n_test, explain: m.explain.slice(0, 60),
    ...(extra.contributors !== undefined ? { contributors: extra.contributors } : {}),
  };
  const row = await trx.insertInto('loom.model_versions').values({
    business_id: s.businessId, sector: s.businessId ? null : s.sector, model_kind: m.kind, algorithm: m.algorithm, version,
    train_from: m.split.train_from, train_to: m.split.train_to, split_at: m.split.split_at, test_to: m.split.test_to,
    data_hash: m.data_hash, data_version: extra.data_version, params: JSON.stringify(m.params), metrics: JSON.stringify(metrics), gate: JSON.stringify(extra.gate),
    created_by: extra.actor.userId,
  }).returningAll().executeTakeFirstOrThrow();
  await trx.insertInto('loom.model_events').values({ business_id: s.businessId, model_version_id: row.id, event: 'created', from_status: null, to_status: 'candidate', reason: extra.gate.passed ? 'gate_passed' : 'gate_failed', data: JSON.stringify({ gate: extra.gate.reasons }), actor_id: extra.actor.userId }).execute();
  if (s.businessId) await loomAudit(trx, extra.actor, 'loom.model_trained', s.businessId, { targetType: 'loom_model_version', targetId: row.id, data: { kind: m.kind, version, gate: extra.gate.passed, reasons: extra.gate.reasons } });
  return row;
}

type TransitionOpts = { actor: AuditActor; event: 'shadow_started' | 'activated' | 'retired' | 'rollback' | 'restored'; reason: string; retired_reason?: 'gate_failed' | 'superseded' | 'shadow_failed' | 'replaced' | 'rollback' | 'manual'; shadow_until?: Date; data?: Record<string, unknown> };

/** One audited status change (optimistic on the current status; the DB trigger enforces valid transitions). */
export async function transition(trx: Tx, v: ModelVersion, to: ModelStatus, o: TransitionOpts): Promise<ModelVersion> {
  const now = new Date();
  const set: Record<string, unknown> = { status: to };
  if (to === 'shadow') { set.shadow_from = now; set.shadow_until = o.shadow_until ?? now; }
  if (to === 'active') { set.promoted_at = now; set.promoted_by = o.actor.userId; set.retired_at = null; set.retired_reason = null; }
  if (to === 'retired') { set.retired_at = now; set.retired_reason = o.retired_reason ?? 'manual'; }
  const row = await trx.updateTable('loom.model_versions').set(set).where('id', '=', v.id).where('status', '=', v.status).returningAll().executeTakeFirst();
  if (!row) throw new AppError(409, 'model_status_changed', 'The model version changed meanwhile; reload.');
  await trx.insertInto('loom.model_events').values({
    business_id: v.business_id, model_version_id: v.id, event: o.event, from_status: v.status, to_status: to, reason: o.reason, data: JSON.stringify(o.data ?? {}), actor_id: o.actor.userId,
  }).execute();
  if (v.business_id) await loomAudit(trx, o.actor, `loom.model_${o.event}`, v.business_id, { targetType: 'loom_model_version', targetId: v.id, data: { kind: v.model_kind, version: v.version, from: v.status, to, reason: o.reason } });
  return row;
}

export async function recordTrainingRun(trx: Tx, r: { businessId: string | null; sector?: string | null; status: 'trained' | 'ineligible' | 'disabled' | 'skipped' | 'failed'; eligibility?: unknown; summary?: unknown; data_version?: string | null; trigger: 'schedule' | 'manual' | 'test'; actor: AuditActor }) {
  await trx.insertInto('loom.model_training_runs').values({
    business_id: r.businessId, sector: r.sector ?? null, status: r.status, eligibility: JSON.stringify(r.eligibility ?? {}), summary: JSON.stringify(r.summary ?? {}),
    data_version: r.data_version ?? null, trigger: r.trigger, actor_id: r.actor.userId,
  }).execute();
}

export async function insertForecasts(trx: Tx, businessId: string, rows: ForecastRow[], meta: { data_version: string | null; analysis_id?: string | null }) {
  const batch = randomUUID();
  const values = rows.map((r) => ({
    business_id: businessId, batch_id: batch, model_kind: r.model_kind, source: r.source, model_version_id: r.model_version_id, algorithm: r.algorithm,
    subject_key: r.subject_key, subject: JSON.stringify({ ...r.subject, version: r.version }), horizon_from: r.horizon_from, horizon_to: r.horizon_to,
    value: r.value, interval_low: r.low, interval_high: r.high, unit: r.unit, data_version: meta.data_version, analysis_id: meta.analysis_id ?? null,
  }));
  for (let i = 0; i < values.length; i += 500) await trx.insertInto('loom.forecasts').values(values.slice(i, i + 500)).execute();
  return batch;
}

/**
 * The latest forecast batch per kind, keeping only rows that are a labelled
 * baseline or come from a version that is STILL active (a rollback hides the
 * retired version's forecasts at once).
 */
export async function latestForecasts(trx: Tx, businessId: string): Promise<Array<ForecastRow & { created_at: Date }>> {
  // The newest batch per kind (batch ids, not timestamps: JS dates lose the microseconds).
  const latest = await trx.selectFrom('loom.forecasts').distinctOn('model_kind').select(['model_kind', 'batch_id']).where('business_id', '=', businessId)
    .orderBy('model_kind').orderBy('created_at', 'desc').execute();
  const out: Array<ForecastRow & { created_at: Date }> = [];
  for (const l of latest) {
    const rows = await trx.selectFrom('loom.forecasts as f').leftJoin('loom.model_versions as v', 'v.id', 'f.model_version_id')
      .select(['f.model_kind', 'f.source', 'f.model_version_id', 'f.algorithm', 'f.subject_key', 'f.subject', 'f.horizon_from', 'f.horizon_to', 'f.value', 'f.interval_low', 'f.interval_high', 'f.unit', 'f.created_at', 'v.status', 'v.version'])
      .where('f.business_id', '=', businessId).where('f.batch_id', '=', l.batch_id)
      .orderBy('f.subject_key').execute();
    for (const r of rows) {
      if (r.source === 'model' && r.status !== 'active') continue;
      out.push({
        model_kind: r.model_kind as ModelKind, source: r.source as 'model' | 'baseline', model_version_id: r.model_version_id, version: r.version ?? null, algorithm: r.algorithm,
        subject_key: r.subject_key, subject: r.subject as Record<string, unknown>, horizon_from: r.horizon_from, horizon_to: r.horizon_to, value: r.value, low: r.interval_low, high: r.interval_high,
        unit: r.unit as 'count' | 'ratio', created_at: r.created_at,
      });
    }
  }
  return out;
}

export async function insertShadowPredictions(trx: Tx, businessId: string, shadow: ModelVersion, ref: { source: 'active' | 'baseline'; version_id: string | null; algorithm: string }, rows: Array<{ subject_key: string; from: string; to: string; shadow: number; reference: number }>) {
  const values = rows.map((r) => ({
    business_id: businessId, model_version_id: shadow.id, model_kind: shadow.model_kind, reference_source: ref.source, reference_version_id: ref.version_id, reference_algorithm: ref.algorithm,
    subject_key: r.subject_key, period_from: r.from, period_to: r.to, shadow_value: r.shadow, reference_value: r.reference,
  }));
  for (let i = 0; i < values.length; i += 500) await trx.insertInto('loom.shadow_predictions').values(values.slice(i, i + 500)).execute();
}
