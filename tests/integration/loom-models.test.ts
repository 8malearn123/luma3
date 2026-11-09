import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { withSystem, withTenant } from '@/server/db/client';
import {
  analyzeNow, consentingBusinesses, evaluateShadows, LEARNED_MODEL_DEFAULTS, latestForecasts, refreshForecasts, rollbackModel, trainBusiness, trainSectorModel,
  type CanonicalDataset, type CardContent, type LearnedModelSettings,
} from '@/loom';
import * as models from '@/app/api/v1/t/[tenantSlug]/loom/models/route';
import * as consent from '@/app/api/v1/t/[tenantSlug]/loom/models/consent/route';
import * as forecastsRoute from '@/app/api/v1/t/[tenantSlug]/loom/models/forecasts/route';
import * as rollbackRoute from '@/app/api/v1/t/[tenantSlug]/loom/models/rollback/route';
import * as promoteRoute from '@/app/api/v1/t/[tenantSlug]/loom/models/versions/[id]/promote/route';
import * as platformModels from '@/app/api/v1/platform/loom/models/route';
import { addDays } from '@/loom/util/time';
import { createBusinessFor, signup } from '../helpers/factory';
import { addMember, platformUser, stepUp } from '../helpers/platform';
import { loomSalon } from '../helpers/loom-core';
import { NOW, TODAY } from '../helpers/loom-dataset';
import { asOf, syntheticHistory } from '../helpers/loom-models';

/**
 * Phase 6 on real Postgres: eligibility, candidate → shadow → active, rollback,
 * consent (default false) and sector training on consenting businesses only,
 * tenant isolation (T12), forecasts labelled model_forecast and only from
 * active versions, append-only tables and frozen versions.
 */
const DAY = 86_400_000;
async function setModels(patch: Partial<LearnedModelSettings>) {
  const v = JSON.stringify({ ...LEARNED_MODEL_DEFAULTS, ...patch });
  await withSystem('test: learned model settings', (trx) => trx.insertInto('loom.loom_settings').values({ key: 'platform.learned_models', value: v })
    .onConflict((oc) => oc.column('key').doUpdateSet({ value: v })).execute());
}
async function setThresholds(min_days: number, min_completed_transactions: number) {
  const v = JSON.stringify({ min_days, min_completed_transactions });
  await withSystem('test: thresholds', (trx) => trx.insertInto('loom.loom_settings').values({ key: 'platform.learned_model_thresholds', value: v })
    .onConflict((oc) => oc.column('key').doUpdateSet({ value: v })).execute());
}
/** Re-labels a synthetic history onto real offering ids (so forecasts land on a LUMA tenant's cards). */
function onto(ds: CanonicalDataset, from: string[], to: string[]): CanonicalDataset {
  const m = new Map(from.map((id, i) => [id, to[i % to.length]!]));
  return {
    ...ds,
    offerings: ds.offerings.map((o) => ({ ...o, id: m.get(o.id) ?? o.id })),
    transactions: ds.transactions.map((t) => ({ ...t, lines: t.lines.map((l) => ({ ...l, offering_id: m.get(l.offering_id) ?? l.offering_id })) })),
  };
}
const versions = (businessId: string) => withTenant(businessId, (trx) => trx.selectFrom('loom.model_versions').selectAll().where('business_id', '=', businessId).orderBy('version').execute());

beforeAll(async () => { await setModels({ enabled: true }); });
afterAll(async () => { await withSystem('test: reset loom settings', (trx) => trx.deleteFrom('loom.loom_settings').execute()); });

describe('phase 6 — eligibility and the platform switch', () => {
  it('switch off ⇒ nothing trained; below the thresholds ⇒ baseline only, recorded with reasons; above ⇒ trained', async () => {
    const s = await loomSalon({ name: 'Models Eligibility' });
    await setModels({ enabled: false });
    expect((await trainBusiness(s.biz.tenantId, { trigger: 'test' })).status).toBe('disabled');
    await setModels({ enabled: true });
    // The real LUMA data of the salon (30 bookings) is far below 180 days / 500 transactions.
    const r = await trainBusiness(s.biz.tenantId, { trigger: 'test' });
    expect(r.status).toBe('ineligible');
    expect(r.eligibility!.completed_transactions).toBe(30);
    const ov = await s.owner.call(models.GET, { params: s.p });
    expect(ov.status).toBe(200);
    expect(ov.body.data.eligibility).toMatchObject({ status: 'ineligible', eligible: false });
    expect(ov.body.data.eligibility.reasons.join(' ')).toMatch(/500/);
    expect(ov.body.data.kinds.every((k: { serving: string }) => k.serving === 'baseline')).toBe(true);
    expect(await versions(s.biz.tenantId)).toHaveLength(0);
    // Thresholds come from the platform settings, not code constants.
    await setThresholds(30, 50);
    const { ds } = syntheticHistory({ seed: 5, days: 120, customers: 150 });
    const e = await trainBusiness(s.biz.tenantId, { dataset: ds, trigger: 'test', now: NOW });
    expect(e.status).toBe('trained');
    await withSystem('test: thresholds', (trx) => trx.deleteFrom('loom.loom_settings').where('key', '=', 'platform.learned_model_thresholds').execute());
  });
});

describe('phase 6 — candidate → shadow → active, forecasts, rollback', () => {
  let s: Awaited<ReturnType<typeof loomSalon>>;
  let full: CanonicalDataset;
  const trainAt = new Date(NOW.getTime() - 20 * DAY);
  beforeAll(async () => {
    s = await loomSalon({ name: 'Models Lifecycle' });
    const h = syntheticHistory({ seed: 7, offerings: 2 });
    full = onto(h.ds, h.offerings, [s.s1, s.s2]);
  });

  it('a candidate that beats the baseline goes to shadow; the shadow is compared on realised data and becomes active', async () => {
    const r = await trainBusiness(s.biz.tenantId, { dataset: asOf(full, addDays(TODAY, -20)), now: trainAt, trigger: 'test' });
    expect(r.status).toBe('trained');
    expect(r.kinds.demand_forecast).toMatchObject({ status: 'shadow', version: 1 });
    expect(r.kinds.intervention_response).toMatchObject({ status: 'baseline_only', reason: 'not_enough_measured_outcomes' });
    const vs = await versions(s.biz.tenantId);
    const demand = vs.find((v) => v.model_kind === 'demand_forecast')!;
    expect(demand).toMatchObject({ status: 'shadow', algorithm: 'poisson_glm_v1' });
    expect(demand.split_at < demand.test_to && demand.train_to <= demand.split_at).toBe(true);
    const gate = demand.gate as { passed: boolean; checks: Array<{ against: string }> };
    expect(gate.passed).toBe(true);
    expect(gate.checks.map((c) => c.against)).toEqual(['baseline']);
    const m = demand.metrics as { candidate: { primary: { value: number } }; baseline: { primary: { value: number }; algorithm: string } };
    expect(m.candidate.primary.value).toBeLessThan(m.baseline.primary.value);
    const preds = await withTenant(s.biz.tenantId, (trx) => trx.selectFrom('loom.shadow_predictions').selectAll().where('model_version_id', '=', demand.id).execute());
    expect(preds.length).toBe(2 * 14);
    expect(preds.every((p) => p.reference_source === 'baseline')).toBe(true);
    // Shadow forecasts never reach forecasts (only the active version / baseline do).
    const fc0 = await refreshForecasts(s.biz.tenantId, { dataset: asOf(full, addDays(TODAY, -20)) });
    expect(fc0.filter((f) => f.model_kind === 'demand_forecast').every((f) => f.source === 'baseline')).toBe(true);
    // Retraining on identical data is idempotent.
    expect((await trainBusiness(s.biz.tenantId, { dataset: asOf(full, addDays(TODAY, -20)), now: trainAt, trigger: 'test' })).kinds.demand_forecast).toMatchObject({ status: 'skipped' });

    // 20 days later: the 14-day shadow window is realised.
    const e = await evaluateShadows(s.biz.tenantId, { dataset: full, now: NOW });
    expect(e).toMatchObject({ evaluated: 1, activated: 1 });
    const after = (await versions(s.biz.tenantId)).find((v) => v.id === demand.id)!;
    expect(after.status).toBe('active');
    expect(after.shadow_result).toMatchObject({ passed: true, n: 28, metric: 'wape' });
    const events = await withTenant(s.biz.tenantId, (trx) => trx.selectFrom('loom.model_events').select(['event', 'from_status', 'to_status']).where('model_version_id', '=', demand.id).orderBy('created_at').execute());
    expect(events.map((x) => x.event)).toEqual(['created', 'shadow_started', 'shadow_evaluated', 'activated']);
    const audit = await withTenant(s.biz.tenantId, (trx) => trx.selectFrom('audit_logs').select('action').where('action', 'like', 'loom.model_%').execute());
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['loom.model_trained', 'loom.model_shadow_started', 'loom.model_activated']));
  });

  it('forecasts come from the active version, are labelled model_forecast on cards next to (never mixed with) the proposed goals', async () => {
    const latest = await withTenant(s.biz.tenantId, (trx) => latestForecasts(trx, s.biz.tenantId));
    const demand = latest.filter((f) => f.model_kind === 'demand_forecast');
    expect(demand.length).toBe(2 * 14);
    expect(demand.every((f) => f.source === 'model' && f.version === 1 && f.low <= f.value && f.value <= f.high)).toBe(true);
    // The real LUMA analysis of the salon: cards carry forecast entries from the active version.
    const out = await analyzeNow(s.biz.tenantId);
    expect(out?.status).toBe('succeeded');
    expect(out!.result.forecasts).toMatchObject({ sources: expect.arrayContaining(['demand_forecast:model']) });
    const opps = await withTenant(s.biz.tenantId, (trx) => trx.selectFrom('loom.opportunities').select(['card', 'category']).where('business_id', '=', s.biz.tenantId).execute());
    const metrics = opps.flatMap((o) => (o.card as CardContent).success_metrics);
    const fc = metrics.filter((m) => m.target_kind === 'model_forecast');
    expect(fc.length).toBeGreaterThan(0);
    for (const m of fc) {
      expect(m.baseline).toBeNull();
      expect(m.metric_key).toMatch(/^forecast\./);
      expect(m.forecast).toBeDefined();
      if (m.forecast!.model_kind === 'demand_forecast') expect(m.forecast).toMatchObject({ source: 'model', version: 1, interval: 0.9 });
    }
    expect(metrics.filter((m) => m.target_kind === 'proposed_goal').every((m) => !m.forecast && !m.metric_key.startsWith('forecast.'))).toBe(true);
    const api = await s.owner.call(forecastsRoute.GET, { params: s.p });
    expect(api.body.data.every((f: { target_kind: string; source: string }) => f.target_kind === 'model_forecast' && ['model', 'baseline'].includes(f.source))).toBe(true);
  });

  it('the DB refuses a forecast from a non-active version', async () => {
    const shadowOrRetired = (await versions(s.biz.tenantId)).find((v) => v.status !== 'active')!;
    await expect(withTenant(s.biz.tenantId, (trx) => trx.insertInto('loom.forecasts').values({
      business_id: s.biz.tenantId, batch_id: crypto.randomUUID(), model_kind: shadowOrRetired.model_kind, source: 'model', model_version_id: shadowOrRetired.id, algorithm: 'x', subject_key: 'x',
      horizon_from: TODAY, horizon_to: TODAY, value: 1, interval_low: 0, interval_high: 2, unit: 'count',
    }).execute())).rejects.toThrow(/active model version/);
  });

  it('a second version must beat the active one too; rollback restores the previous active version, then the baseline', async () => {
    // A stricter margin than any realistic improvement: the new candidate is retired by the gate, the active stays.
    await setModels({ enabled: true, promotion_margin: { ...LEARNED_MODEL_DEFAULTS.promotion_margin, demand_forecast: 0.5 } });
    const strict = await trainBusiness(s.biz.tenantId, { dataset: asOf(full, addDays(TODAY, -6)), now: new Date(NOW.getTime() - 6 * DAY), trigger: 'test' });
    expect(strict.kinds.demand_forecast).toMatchObject({ status: 'gate_failed' });
    const failed = (await versions(s.biz.tenantId)).filter((v) => v.model_kind === 'demand_forecast').at(-1)!;
    expect(failed).toMatchObject({ status: 'retired', retired_reason: 'gate_failed' });
    expect((failed.gate as { checks: Array<{ against: string }> }).checks.map((c) => c.against)).toEqual(['baseline', 'active']);
    // Manual promotion never bypasses the gate.
    const denied = await s.owner.call(promoteRoute.POST, { method: 'POST', params: { ...s.p, id: failed.id } });
    expect(denied.status).toBe(409);

    // Version 3 (trained 11 days ago, margin 0, generous guardrails, 7-day shadow) beats version 1 on the realised week and replaces it.
    await setModels({ enabled: true, promotion_margin: { demand_forecast: 0, return_probability: 0, intervention_response: 0 }, guardrail_tolerance: 0.5, shadow_days: 7 });
    const v3 = await trainBusiness(s.biz.tenantId, { dataset: asOf(full, addDays(TODAY, -11)), now: new Date(NOW.getTime() - 11 * DAY), trigger: 'test' });
    expect(v3.kinds.demand_forecast).toMatchObject({ status: 'shadow', version: 3 });
    await evaluateShadows(s.biz.tenantId, { dataset: full, now: NOW });
    let vs = (await versions(s.biz.tenantId)).filter((v) => v.model_kind === 'demand_forecast');
    expect(vs.map((v) => [v.version, v.status])).toEqual([[1, 'retired'], [2, 'retired'], [3, 'active']]);
    expect(vs[0]!.retired_reason).toBe('replaced');

    // A member without loom.manage (marketing.manage) cannot roll back; the owner can, in one click.
    const viewer = await addMember(s.owner, s.biz.slug, 'manager');
    expect((await viewer.call(rollbackRoute.POST, { method: 'POST', params: s.p, body: { model_kind: 'demand_forecast' } })).status).toBe(403);
    const rb = await s.owner.call(rollbackRoute.POST, { method: 'POST', params: s.p, body: { model_kind: 'demand_forecast' } });
    expect(rb.status).toBe(200);
    expect(rb.body.data).toEqual({ retired_version: 3, restored_version: 1, fallback: 'previous_version' });
    vs = (await versions(s.biz.tenantId)).filter((v) => v.model_kind === 'demand_forecast');
    expect(vs.map((v) => [v.version, v.status])).toEqual([[1, 'active'], [2, 'retired'], [3, 'retired']]);
    // Forecasts of the rolled-back version disappear at once (they were from v3).
    const latest = await withTenant(s.biz.tenantId, (trx) => latestForecasts(trx, s.biz.tenantId));
    expect(latest.filter((f) => f.model_kind === 'demand_forecast' && f.version === 3)).toHaveLength(0);
    // Second rollback: no previous version ⇒ baseline.
    expect(await rollbackModel(s.biz.tenantId, 'demand_forecast', { userId: null, kind: 'system' })).toMatchObject({ retired_version: 1, restored_version: null, fallback: 'baseline' });
    expect((await s.owner.call(rollbackRoute.POST, { method: 'POST', params: s.p, body: { model_kind: 'demand_forecast' } })).status).toBe(409);
    const ev = await withTenant(s.biz.tenantId, (trx) => trx.selectFrom('loom.model_events').select(['event']).where('business_id', '=', s.biz.tenantId).where('event', 'in', ['rollback', 'restored']).execute());
    expect(ev.map((e) => e.event).sort()).toEqual(['restored', 'rollback', 'rollback']);
    await setModels({ enabled: true });
  });

  it('append-only tables and frozen versions are enforced by the database', async () => {
    const v = (await versions(s.biz.tenantId))[0]!;
    const t = s.biz.tenantId;
    await expect(withTenant(t, (trx) => trx.updateTable('loom.model_versions').set({ params: JSON.stringify({}) }).where('id', '=', v.id).execute())).rejects.toThrow(/frozen/);
    await expect(withTenant(t, (trx) => trx.deleteFrom('loom.model_versions').where('id', '=', v.id).execute())).rejects.toThrow();
    for (const table of ['model_events', 'forecasts', 'shadow_predictions', 'model_training_runs'] as const) {
      await expect(withTenant(t, (trx) => sql`update ${sql.table(`loom.${table}`)} set created_at = now() where business_id = ${t}`.execute(trx))).rejects.toThrow();
      await expect(withTenant(t, (trx) => sql`delete from ${sql.table(`loom.${table}`)} where business_id = ${t}`.execute(trx))).rejects.toThrow();
    }
    // Invalid transition (retired by the gate → active) is refused.
    const gateFailed = (await versions(t)).find((x) => x.retired_reason === 'gate_failed')!;
    await expect(withTenant(t, (trx) => trx.updateTable('loom.model_versions').set({ status: 'active' }).where('id', '=', gateFailed.id).execute())).rejects.toThrow(/transition/);
  });

  it('T12: another business sees none of these versions, forecasts or events, and cannot act on them', async () => {
    const other = await loomSalon({ name: 'Models Other' });
    const mine = await versions(s.biz.tenantId);
    const seen = await withTenant(other.biz.tenantId, (trx) => trx.selectFrom('loom.model_versions').select('id').execute());
    expect(seen).toHaveLength(0);
    expect(await withTenant(other.biz.tenantId, (trx) => trx.selectFrom('loom.forecasts').select('id').where('business_id', '=', s.biz.tenantId).execute())).toHaveLength(0);
    expect(await withTenant(other.biz.tenantId, (trx) => trx.selectFrom('loom.model_events').select('id').execute())).toHaveLength(0);
    const ov = await other.owner.call(models.GET, { params: other.p });
    expect(ov.body.data.kinds.flatMap((k: { recent: unknown[] }) => k.recent)).toHaveLength(0);
    expect((await other.owner.call(promoteRoute.POST, { method: 'POST', params: { ...other.p, id: mine[0]!.id } })).status).toBe(404);
  });
});

describe('phase 6 — shared-training consent and sector models', () => {
  it('consent defaults to false, is owner only, recorded with who/when and audited', async () => {
    const s = await loomSalon({ name: 'Models Consent' });
    const g = await s.owner.call(consent.GET, { params: s.p });
    expect(g.body.data).toMatchObject({ shared_training_consent: false, decided: false, updated_at: null });
    const manager = await addMember(s.owner, s.biz.slug, 'manager', ['marketing.manage']);
    const denied = await manager.call(consent.PUT, { method: 'PUT', params: s.p, body: { shared_training_consent: true } });
    expect(denied.status).toBe(403);
    expect(denied.body.error.details.reason).toBe('owner_only');
    const ok = await s.owner.call(consent.PUT, { method: 'PUT', params: s.p, body: { shared_training_consent: true } });
    expect(ok.body.data).toMatchObject({ shared_training_consent: true, decided: true });
    expect(ok.body.data.updated_by).toBeTruthy();
    const audit = await withTenant(s.biz.tenantId, (trx) => trx.selectFrom('audit_logs').select(['action', 'data']).where('action', '=', 'loom.shared_training_consent').execute());
    expect(audit).toHaveLength(1);
    expect(audit[0]!.data).toMatchObject({ before: false, after: true });
  });

  it('sector models train only on aggregates of consenting businesses (≥ 3), stored without a business, platform-only', async () => {
    const owners = await Promise.all(['A', 'B', 'C', 'D', 'E'].map((n) => signup(`Sector ${n}`)));
    const bizs = await Promise.all(owners.map((o) => createBusinessFor(o, { plan_code: 'wahaj' })));
    const p = (i: number) => ({ tenantSlug: bizs[i]!.slug });
    for (const i of [0, 1, 2, 4]) expect((await owners[i]!.call(consent.PUT, { method: 'PUT', params: p(i), body: { shared_training_consent: true } })).status).toBe(200);
    // E withdraws; D never decided (default false).
    await owners[4]!.call(consent.PUT, { method: 'PUT', params: p(4), body: { shared_training_consent: false } });
    const consenting = await consentingBusinesses('beauty');
    expect(consenting).toEqual(expect.arrayContaining([0, 1, 2].map((i) => bizs[i]!.tenantId)));
    expect(consenting).not.toContain(bizs[3]!.tenantId);
    expect(consenting).not.toContain(bizs[4]!.tenantId);

    const loaded: string[] = [];
    const loader = async (id: string) => { loaded.push(id); return syntheticHistory({ seed: 100 + bizs.findIndex((b) => b.tenantId === id) }).ds; };
    await setModels({ enabled: true, sector_models: false });
    expect((await trainSectorModel('beauty', { loader, trigger: 'test' })).status).toBe('disabled');
    expect(loaded).toHaveLength(0);
    await setModels({ enabled: true, sector_models: true, promotion_margin: { demand_forecast: 0.05, return_probability: 0, intervention_response: 0.05 }, guardrail_tolerance: 0.5 });
    const r = await trainSectorModel('beauty', { loader, trigger: 'test', now: NOW });
    expect(loaded).not.toContain(bizs[3]!.tenantId);
    expect(loaded).not.toContain(bizs[4]!.tenantId);
    expect(r).toMatchObject({ contributors: loaded.length });
    expect(['shadow', 'gate_failed']).toContain(r.status);
    const sector = await withSystem('test: sector versions', (trx) => trx.selectFrom('loom.model_versions').selectAll().where('business_id', 'is', null).execute());
    expect(sector).toHaveLength(1);
    expect(sector[0]).toMatchObject({ sector: 'beauty', model_kind: 'return_probability', algorithm: 'sector_logistic_v1' });
    expect(sector[0]!.metrics).toMatchObject({ contributors: loaded.length });
    expect(JSON.stringify(sector[0]!.params)).not.toMatch(new RegExp(bizs.map((b) => b.tenantId).join('|')));
    // Invisible to any business; visible to the platform owner.
    expect(await withTenant(bizs[0]!.tenantId, (trx) => trx.selectFrom('loom.model_versions').select('id').where('business_id', 'is', null).execute())).toHaveLength(0);
    const admin = await platformUser('platform_owner');
    const list = await admin.call(platformModels.GET);
    expect(list.status).toBe(200);
    expect(list.body.data.versions.map((v: { id: string }) => v.id)).toContain(sector[0]!.id);
    expect((await owners[0]!.call(platformModels.GET)).status).toBe(404);
    await stepUp(admin);
    const early = await admin.call(platformModels.POST, { method: 'POST', body: { action: 'promote', version_id: sector[0]!.id } });
    expect(early.status).toBe(409);
    await setModels({ enabled: true });
  });
});
