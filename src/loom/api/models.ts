import { z } from 'zod';
import { audit, withSystem, withTenant, type AuditActor } from '../db';
import { loomAudit } from '../hosts';
import { eligibility as eligibilityOf } from '../models/governance';
import { latestForecasts } from '../models/store';
import { promoteSectorVersion, promoteVersion, requestTraining, rollback, rollbackSector, trainSectorModel } from '../models/service';
import { MODEL_KINDS, type ModelKind } from '../models/types';
import { loadFacts, writeFact } from '../profile/facts';
import { readPlatformSettings } from '../settings/platform';
import { render, type Localized, type LoomLocale } from '../util/text';

/**
 * Loom API v1 — learned models (phase 6, «النماذج», experimental). Host
 * agnostic: { businessId, actor, locale }. Capabilities are enforced by the
 * host routes (view: list; manage: promote / rollback / train; consent: the
 * owner, like the setup checklist).
 */
type Ctx = { businessId: string; actor: AuditActor; locale: LoomLocale };
type ViewCtx = Pick<Ctx, 'businessId' | 'locale'>;

export const modelKindSchema = z.enum(MODEL_KINDS);
export const consentInput = z.object({ shared_training_consent: z.boolean() }).strict();
export const rollbackInput = z.object({ model_kind: modelKindSchema }).strict();
export const versionsQuery = z.object({ kind: modelKindSchema.optional() }).strict();
export const platformModelsInput = z.discriminatedUnion('action', [
  z.object({ action: z.literal('train_sector'), sector: z.enum(['beauty', 'retail']) }).strict(),
  z.object({ action: z.literal('promote'), version_id: z.string().uuid() }).strict(),
  z.object({ action: z.literal('rollback'), sector: z.enum(['beauty', 'retail']), model_kind: modelKindSchema }).strict(),
]);

type VersionRow = {
  id: string; model_kind: string; algorithm: string; version: number; status: string; train_from: string; train_to: string; split_at: string; test_to: string;
  data_hash: string; data_version: string | null; metrics: unknown; gate: unknown; shadow_from: Date | null; shadow_until: Date | null; shadow_result: unknown;
  promoted_at: Date | null; retired_at: Date | null; retired_reason: string | null; created_at: Date; sector?: string | null;
};
const versionView = (v: VersionRow) => {
  const m = v.metrics as { primary_metric: string; candidate: unknown; baseline: unknown; active: unknown; n_train: number; n_test: number; explain: unknown; contributors?: number };
  return {
    id: v.id, model_kind: v.model_kind, algorithm: v.algorithm, version: v.version, status: v.status, sector: v.sector ?? null,
    training: { from: v.train_from, to: v.train_to, split_at: v.split_at, test_to: v.test_to, data_hash: v.data_hash, data_version: v.data_version, n_train: m.n_train, n_test: m.n_test },
    metrics: { primary: m.primary_metric, candidate: m.candidate, baseline: m.baseline, active: m.active, ...(m.contributors !== undefined ? { contributors: m.contributors } : {}) },
    explain: m.explain, gate: v.gate,
    shadow: { from: v.shadow_from, until: v.shadow_until, result: v.shadow_result },
    promoted_at: v.promoted_at, retired_at: v.retired_at, retired_reason: v.retired_reason, created_at: v.created_at,
  };
};

async function consentOf(businessId: string) {
  return withTenant(businessId, async (trx) => {
    const f = (await loadFacts(trx, businessId)).find((x) => x.key === 'consent.shared_training' && x.kind === 'explicit');
    return { shared_training_consent: f?.value === true, decided: !!f, updated_at: f?.updated_at ?? null, updated_by: f?.updated_by ?? null };
  });
}

/** GET /loom/models — eligibility (and why), per kind: active / shadow / latest candidates with metrics vs baseline, consent. */
export async function overview(c: ViewCtx) {
  const platform = await withSystem('loom: model settings', (trx) => readPlatformSettings(trx));
  const s = platform.learned_models;
  const data = await withTenant(c.businessId, async (trx) => {
    const versions = await trx.selectFrom('loom.model_versions').selectAll().where('business_id', '=', c.businessId).orderBy('created_at', 'desc').limit(60).execute();
    const run = await trx.selectFrom('loom.model_training_runs').selectAll().where('business_id', '=', c.businessId).orderBy('created_at', 'desc').limit(1).executeTakeFirst();
    const events = await trx.selectFrom('loom.model_events').select(['model_version_id', 'event', 'from_status', 'to_status', 'reason', 'actor_id', 'created_at']).where('business_id', '=', c.businessId).orderBy('created_at', 'desc').limit(30).execute();
    return { versions, run, events };
  });
  const elig = data.run?.eligibility as { eligible?: boolean; history_days?: number; completed_transactions?: number; reasons?: Localized[] } | undefined;
  const kinds = MODEL_KINDS.map((kind) => {
    const vs = data.versions.filter((v) => v.model_kind === kind);
    const summary = (data.run?.summary ?? {}) as Record<string, { status: string; reason?: string }>;
    return {
      kind,
      active: vs.find((v) => v.status === 'active') ? versionView(vs.find((v) => v.status === 'active')!) : null,
      shadow: vs.find((v) => v.status === 'shadow') ? versionView(vs.find((v) => v.status === 'shadow')!) : null,
      candidates: vs.filter((v) => v.status === 'candidate').slice(0, 3).map(versionView),
      recent: vs.slice(0, 5).map(versionView),
      last_training: summary[kind] ?? null,
      serving: vs.some((v) => v.status === 'active') ? 'model' : 'baseline',
      margin: s.promotion_margin[kind],
    };
  });
  return {
    experimental: true,
    enabled: s.enabled,
    settings: { auto_promote: s.auto_promote, shadow_days: s.shadow_days, retrain_days: s.retrain_days, guardrail_tolerance: s.guardrail_tolerance, min_measured_outcomes: s.min_measured_outcomes },
    thresholds: platform.learned_model_thresholds,
    eligibility: data.run ? {
      status: data.run.status, checked_at: data.run.created_at, eligible: data.run.status === 'trained' ? true : elig?.eligible ?? null,
      history_days: elig?.history_days ?? null, completed_transactions: elig?.completed_transactions ?? null, reasons: (elig?.reasons ?? []).map((r) => render(r, c.locale)),
    } : { status: 'not_checked', checked_at: null, eligible: null, history_days: null, completed_transactions: null, reasons: [] },
    kinds,
    consent: await consentOf(c.businessId),
    events: data.events,
  };
}

export async function listVersions(c: ViewCtx, kind?: ModelKind) {
  return withTenant(c.businessId, async (trx) => {
    let q = trx.selectFrom('loom.model_versions').selectAll().where('business_id', '=', c.businessId);
    if (kind) q = q.where('model_kind', '=', kind);
    return (await q.orderBy('created_at', 'desc').limit(100).execute()).map(versionView);
  });
}

/** GET /loom/models/forecasts — the latest forecasts per kind: active-version forecasts and labelled baselines only. */
export async function forecasts(c: ViewCtx) {
  const rows = await withTenant(c.businessId, (trx) => latestForecasts(trx, c.businessId));
  return rows.map((r) => ({ ...r, target_kind: 'model_forecast' as const, interval: 0.9 }));
}

export const getConsent = (c: ViewCtx) => consentOf(c.businessId);

/** Shared-training consent: an explicit fact (who/when, superseded history), audited. Default false. */
export async function setConsent(c: Ctx, value: boolean) {
  await withTenant(c.businessId, async (trx) => {
    const before = (await loadFacts(trx, c.businessId)).find((x) => x.key === 'consent.shared_training' && x.kind === 'explicit')?.value === true;
    await writeFact(trx, c.businessId, { key: 'consent.shared_training', value, kind: 'explicit', source_type: 'user', by: c.actor.userId });
    await loomAudit(trx, c.actor, 'loom.shared_training_consent', c.businessId, { targetType: 'loom_consent', data: { before, after: value } });
  });
  return consentOf(c.businessId);
}

export async function promote(c: Ctx, versionId: string) {
  const v = await promoteVersion(c.businessId, versionId, c.actor);
  return { id: v.id, status: v.status, version: v.version };
}
export const rollbackKind = (c: Ctx, kind: ModelKind) => rollback(c.businessId, kind, c.actor);
export const train = (c: Ctx) => requestTraining(c.businessId, c.actor);

/** Eligibility on a dataset (pure helper re-exported for hosts and tests). */
export const eligibilityFor = eligibilityOf;

// ── Platform (sector models) ────────────────────────────────────────────────
export async function platformModels() {
  return withSystem('loom: sector models', async (trx) => {
    const versions = await trx.selectFrom('loom.model_versions').selectAll().where('business_id', 'is', null).orderBy('created_at', 'desc').limit(60).execute();
    const runs = await trx.selectFrom('loom.model_training_runs').selectAll().where('business_id', 'is', null).orderBy('created_at', 'desc').limit(10).execute();
    const businesses = await trx.selectFrom('loom.model_versions').select(['model_kind', 'status', (eb) => eb.fn.countAll<number>().as('n')]).where('business_id', 'is not', null).groupBy(['model_kind', 'status']).execute();
    return { versions: versions.map(versionView), runs: runs.map((r) => ({ sector: r.sector, status: r.status, summary: r.summary, created_at: r.created_at })), business_versions: businesses.map((b) => ({ ...b, n: Number(b.n) })) };
  });
}

export async function platformAction(actor: AuditActor, input: z.infer<typeof platformModelsInput>) {
  await withSystem('loom: audit sector model action', (trx) => audit(trx, actor, `loom.sector_model_${input.action}`, { targetType: 'loom_model_version', targetId: input.action === 'promote' ? input.version_id : null, data: { ...input } }));
  if (input.action === 'train_sector') return trainSectorModel(input.sector, { actor, trigger: 'manual' });
  if (input.action === 'promote') { const v = await promoteSectorVersion(input.version_id, actor); return { id: v.id, status: v.status, version: v.version }; }
  return rollbackSector(input.sector, input.model_kind, actor);
}
