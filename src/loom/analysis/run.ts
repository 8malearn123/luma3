import { schedule, sql, withSystem, withTenant, type Tx } from '../db';
import { connectorFor } from '../connectors/registry';
import type { ConnectionRef } from '../contracts/connector';
import { datasetHash, loadDataset } from '../dataset';
import { MetricContext } from '../metrics/context';
import { computeMetrics, definitionRecord, metricDefinitions, type MetricSet } from '../metrics/registry';
import '../metrics/v1';
import { runEngine } from '../opportunities/engine';
import { persistOpportunities, reservedVolumes } from '../opportunities/store';
import { refreshDerivedFacts } from '../profile/computed';
import { loadFacts, loadGoals, resolveProfile } from '../profile/facts';
import { qualityGate, type QualityReport } from '../quality/gate';
import { sectorPack } from '../sector/beauty';
import { readPlatformSettings } from '../settings/platform';

/**
 * Analysis pipeline (§6.1), rules path:
 *   connection → dataset (connector) → metrics → quality gate → profile →
 *   detectors → checks → interventions → ranking → persist (+ evidence,
 *   checks, events) → result. Deterministic for a given dataset and profile.
 * The LLM planner (phase 3) consumes the persisted opportunities; it is not
 * part of this pipeline.
 */
export const ANALYSIS_JOB = 'loom.analysis';

export async function ensureConnection(trx: Tx, businessId: string, kind = 'luma'): Promise<ConnectionRef> {
  let c = await trx.selectFrom('loom.connections').selectAll().where('business_id', '=', businessId).where('kind', '=', kind).executeTakeFirst();
  if (!c) {
    c = await trx.insertInto('loom.connections').values({ business_id: businessId, kind }).onConflict((oc) => oc.columns(['business_id', 'kind']).doNothing()).returningAll().executeTakeFirst()
      ?? await trx.selectFrom('loom.connections').selectAll().where('business_id', '=', businessId).where('kind', '=', kind).executeTakeFirstOrThrow();
    const m = connectorFor(kind).describe();
    await trx.insertInto('loom.source_mappings').values({ business_id: businessId, connection_id: c.id, entity: 'transactions', revenue_basis: m.revenue_basis, status_map: JSON.stringify(m.status_map), field_map: JSON.stringify({ timezone: m.timezone_source, connector_version: m.version }) })
      .onConflict((oc) => oc.columns(['connection_id', 'entity']).doNothing()).execute();
  }
  return { id: c.id, business_id: businessId, kind: c.kind, config: (c.config ?? {}) as Record<string, unknown> };
}

let definitionsSynced = false;
/** Mirrors the code registry into loom.metric_definitions (insert-only; a new version is a new row). */
export async function syncMetricDefinitions() {
  if (definitionsSynced) return;
  await withSystem('loom: sync metric definitions', async (trx) => {
    for (const d of metricDefinitions()) {
      const r = definitionRecord(d);
      await trx.insertInto('loom.metric_definitions').values({ ...r, grain: r.grain, requires: r.requires, sectors: r.sectors }).onConflict((oc) => oc.columns(['key', 'version']).doNothing()).execute();
    }
  });
  definitionsSynced = true;
}

export async function requestAnalysis(businessId: string, opts: { trigger: 'manual' | 'schedule' | 'seed' | 'test'; requestedBy: string | null; enqueue?: boolean }) {
  return withTenant(businessId, async (trx) => {
    const row = await trx.insertInto('loom.analyses').values({ business_id: businessId, trigger: opts.trigger, requested_by: opts.requestedBy })
      .onConflict((oc) => oc.column('business_id').where('status', 'in', ['queued', 'running']).doNothing()).returningAll().executeTakeFirst();
    if (!row) {
      const live = await trx.selectFrom('loom.analyses').selectAll().where('business_id', '=', businessId).where('status', 'in', ['queued', 'running']).executeTakeFirstOrThrow();
      return { analysis: live, created: false };
    }
    if (opts.enqueue !== false) await schedule(trx, ANALYSIS_JOB, { analysis_id: row.id }, { tenantId: businessId, dedupeKey: `loom_analysis:${row.id}`, maxAttempts: 2 });
    return { analysis: row, created: true };
  });
}

export type AnalysisOutput = {
  analysis_id: string;
  status: 'succeeded' | 'insufficient_data' | 'failed';
  quality: QualityReport;
  metrics: MetricSet;
  result: Record<string, unknown>;
};

async function insertMetricValues(trx: Tx, businessId: string, analysisId: string, metrics: MetricSet, from: string, to: string) {
  const rows = metrics.values.map((v) => ({ business_id: businessId, analysis_id: analysisId, metric_key: v.key, metric_version: v.version, grain_ref: v.grain_ref, value: v.value, n: v.n, status: v.status, period_from: from, period_to: to }));
  for (let i = 0; i < rows.length; i += 500) await trx.insertInto('loom.metric_values').values(rows.slice(i, i + 500)).execute();
}

export async function runAnalysis(analysisId: string, businessId: string, opts: { now?: Date } = {}): Promise<AnalysisOutput | null> {
  const started = new Date();
  const claimed = await withTenant(businessId, (trx) => trx.updateTable('loom.analyses').set({ status: 'running', started_at: started })
    .where('id', '=', analysisId).where('status', '=', 'queued').returning('id').executeTakeFirst());
  if (!claimed) return null;
  try {
    await syncMetricDefinitions();
    const platform = await withSystem('loom: platform settings for analysis', (trx) => readPlatformSettings(trx));
    const conn = await withTenant(businessId, (trx) => ensureConnection(trx, businessId));
    const connector = connectorFor(conn.kind);
    const ds = await loadDataset(connector, { ...conn, as_of: opts.now });
    if (!platform.enabled_sector_packs.includes(ds.business.sector as 'beauty')) {
      await withTenant(businessId, (trx) => trx.updateTable('loom.analyses').set({ status: 'failed', error_code: 'sector_pack_disabled', finished_at: new Date() }).where('id', '=', analysisId).execute());
      return null;
    }
    const pack = sectorPack(ds.business.sector);
    const ctx = new MetricContext(ds, { cost_completeness_threshold: platform.cost_completeness_threshold });
    const metrics = computeMetrics(ctx);
    const quality = qualityGate(ctx);
    const hash = datasetHash(ds);

    return await withTenant(businessId, async (trx) => {
      const prev = await trx.selectFrom('loom.analyses').select(['id']).where('business_id', '=', businessId).where('snapshot_hash', '=', hash).where('id', '!=', analysisId).executeTakeFirst();
      await trx.insertInto('loom.sync_runs').values({ business_id: businessId, connection_id: conn.id, analysis_id: analysisId, status: 'succeeded', entities: JSON.stringify(ds.meta.counts), data_version: ds.meta.data_version, started_at: started }).execute();
      await trx.updateTable('loom.connections').set({ last_sync_at: new Date(), status: 'active', last_error: null }).where('id', '=', conn.id).execute();
      await trx.insertInto('loom.data_quality_checks').values({ business_id: businessId, analysis_id: analysisId, overall: quality.overall, domains: JSON.stringify(quality.domains), checks: JSON.stringify(quality.checks) }).execute();
      await insertMetricValues(trx, businessId, analysisId, metrics, ds.meta.lookback_from, ds.meta.horizon_to);
      await refreshDerivedFacts(trx, businessId, ctx, metrics);
      const profile = resolveProfile(await loadFacts(trx, businessId), await loadGoals(trx, businessId), platform.default_ranking_weights);

      const noData = !ctx.activeOfferings.length || quality.overall === 'insufficient';
      const engine = noData ? { opportunities: [], suppressed: [{ detector_id: '*', reason: 'insufficient_data' }] }
        : runEngine({ ds, ctx, metrics, quality, profile, pack, params: {} }, { reserved: await reservedVolumes(trx, businessId) });
      const budgetFact = profile.facts.find((f) => f.key === 'pref.monthly_budget_minor' && f.kind === 'explicit');
      const persisted = await persistOpportunities(trx, businessId, analysisId, engine.opportunities, {
        today: ds.meta.today, sectorPack: pack.id, sectorPackVersion: pack.version, constraints: { budgetUpdatedAt: budgetFact ? new Date(budgetFact.updated_at) : null },
      });
      const result = {
        mode: quality.exploratory ? 'exploratory' : 'standard',
        snapshot: { hash, data_version: ds.meta.data_version, reused: !!prev, as_of: new Date(ds.meta.as_of).toISOString(), connector: ds.meta.connector },
        quality: { overall: quality.overall, levels: Object.fromEntries(Object.entries(quality.domains).map(([k, v]) => [k, v.level])), regime_change: quality.regime_change, excluded_inconsistent: quality.excluded_inconsistent },
        data_needed: quality.data_needed,
        setup: { complete: profile.setup.complete, missing: profile.setup.missing },
        opportunities: engine.opportunities.length, persisted, suppressed: engine.suppressed,
        market_signals: { live: ds.signals.filter((s) => s.freshness === 'fresh' || s.freshness === 'aging').map((s) => s.id), stale: ds.signals.filter((s) => s.freshness === 'stale' || s.freshness === 'unknown').map((s) => ({ id: s.id, freshness: s.freshness })) },
        sector_pack: pack.version,
      };
      const status = noData ? 'insufficient_data' as const : 'succeeded' as const;
      await trx.updateTable('loom.analyses').set({
        status, finished_at: new Date(), mode: quality.exploratory ? 'exploratory' : 'standard', snapshot_hash: hash, data_version: ds.meta.data_version,
        quality_level: quality.overall, period_from: ds.meta.lookback_from, period_to: ds.meta.horizon_to, result: JSON.stringify(result),
        error_code: noData ? 'insufficient_data' : null,
      }).where('id', '=', analysisId).execute();
      return { analysis_id: analysisId, status, quality, metrics, result };
    });
  } catch (e) {
    await withTenant(businessId, async (trx) => {
      await trx.updateTable('loom.analyses').set({ status: 'failed', error_code: 'analysis_error', error_message: (e as Error).message.slice(0, 500), finished_at: new Date() }).where('id', '=', analysisId).execute();
      const conn = await trx.selectFrom('loom.connections').select('id').where('business_id', '=', businessId).where('kind', '=', 'luma').executeTakeFirst();
      if (conn) await trx.updateTable('loom.connections').set({ last_error: (e as Error).message.slice(0, 500) }).where('id', '=', conn.id).execute();
    });
    throw e;
  }
}

/** Runs an analysis synchronously (seed, tests, CLI). Returns null if another analysis is live. */
export async function analyzeNow(businessId: string, opts: { requestedBy?: string | null; trigger?: 'manual' | 'seed' | 'test'; now?: Date } = {}) {
  const { analysis, created } = await requestAnalysis(businessId, { trigger: opts.trigger ?? 'test', requestedBy: opts.requestedBy ?? null, enqueue: false });
  if (!created) return null;
  return runAnalysis(analysis.id, businessId, { now: opts.now });
}

/** Sweeps analyses stuck in 'running' (worker crash) back to failed after 30 minutes. */
export async function failStuckAnalyses() {
  await withSystem('loom: stuck analyses', (trx) => sql`update loom.analyses set status = 'failed', error_code = 'timeout', finished_at = now()
    where status = 'running' and started_at < now() - interval '30 minutes'`.execute(trx));
}
