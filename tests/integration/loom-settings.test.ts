import { afterAll, describe, expect, it } from 'vitest';
import { withSystem, withTenant } from '@/server/db/client';
import { analyzeNow, PLATFORM_DEFAULTS } from '@/loom';
import * as platformLoom from '@/app/api/v1/platform/loom/settings/route';
import * as setup from '@/app/api/v1/t/[tenantSlug]/loom/setup/route';
import * as profile from '@/app/api/v1/t/[tenantSlug]/loom/profile/route';
import * as goals from '@/app/api/v1/t/[tenantSlug]/loom/goals/route';
import * as prefs from '@/app/api/v1/t/[tenantSlug]/loom/preferences/route';
import * as opps from '@/app/api/v1/t/[tenantSlug]/loom/opportunities/route';
import * as marketingPrefs from '@/app/api/v1/t/[tenantSlug]/marketing/preferences/route';
import { addMember, expireStepUp, platformUser, stepUp } from '../helpers/platform';
import { signup } from '../helpers/factory';
import { loomSalon } from '../helpers/loom-core';

afterAll(async () => {
  // Restore platform defaults for the other suites.
  await withSystem('test: reset loom settings', (trx) => trx.deleteFrom('loom.loom_settings').execute());
});

describe('Loom platform settings (/platform/loom)', () => {
  it('only the platform owner (with step-up) edits them; every key change is audited', async () => {
    const owner = await platformUser('platform_owner');
    const support = await platformUser('support_admin');
    const stranger = await signup('Nobody');
    expect((await stranger.call(platformLoom.GET)).status).toBe(404);
    expect((await support.call(platformLoom.GET)).status).toBe(404);
    const g = await owner.call(platformLoom.GET);
    expect(g.status).toBe(200);
    expect(g.body.data.settings).toEqual(PLATFORM_DEFAULTS);
    expect(g.body.data.meta.cost_completeness_threshold.is_default).toBe(true);

    await expireStepUp(owner.identifier);
    const noStep = await owner.call(platformLoom.PUT, { method: 'PUT', body: { cost_completeness_threshold: 0.9 } });
    expect(noStep.status).toBe(401);
    expect(noStep.body.error.code).toMatch(/step_up|reauth/);
    await stepUp(owner);
    const bad = await owner.call(platformLoom.PUT, { method: 'PUT', body: { default_ranking_weights: { ...PLATFORM_DEFAULTS.default_ranking_weights, risk: 0.3 } } });
    expect(bad.status).toBe(422);
    expect((await owner.call(platformLoom.PUT, { method: 'PUT', body: { event_sources: [{ id: 'x', name: 'Bad', url: 'http://insecure.example', region: 'SA', kind: 'other', license_note: '', enabled: true }] } })).status).toBe(422);
    const ok = await owner.call(platformLoom.PUT, { method: 'PUT', body: {
      cost_completeness_threshold: 0.9,
      learned_model_thresholds: { min_days: 200, min_completed_transactions: 600 },
      event_sources: [{ id: 'sa-official', name: 'التقويم الرسمي', url: 'https://example.gov.sa/calendar', region: 'SA', kind: 'official_calendar', license_note: 'public', enabled: true }],
    } });
    expect(ok.status).toBe(200);
    expect(ok.body.data.settings).toMatchObject({ cost_completeness_threshold: 0.9, learned_model_thresholds: { min_days: 200 }, enabled_sector_packs: ['beauty'] });
    expect(ok.body.data.meta.cost_completeness_threshold).toMatchObject({ version: 1, is_default: false });
    const audit = await withSystem('test: audit', (trx) => trx.selectFrom('audit_logs').select(['action', 'data']).where('action', '=', 'loom.platform_setting_updated').execute());
    expect(audit.map((a) => (a.data as { key: string }).key).sort()).toEqual(['cost_completeness_threshold', 'event_sources', 'learned_model_thresholds']);
    await owner.call(platformLoom.PUT, { method: 'PUT', body: { cost_completeness_threshold: PLATFORM_DEFAULTS.cost_completeness_threshold } });
  });

  it('the cost-completeness threshold and enabled packs drive the analysis (not code constants)', async () => {
    const s = await loomSalon();
    // S1 4000 cost known, S2 known: lower the threshold to 0.5 … then disable the beauty pack.
    await withSystem('test: settings', (trx) => trx.insertInto('loom.loom_settings').values({ key: 'platform.enabled_sector_packs', value: JSON.stringify(['retail']) })
      .onConflict((oc) => oc.column('key').doUpdateSet({ value: JSON.stringify(['retail']) })).execute());
    const r = await analyzeNow(s.biz.tenantId);
    expect(r).toBeNull();
    const a = await withTenant(s.biz.tenantId, (trx) => trx.selectFrom('loom.analyses').select(['status', 'error_code']).orderBy('created_at', 'desc').executeTakeFirstOrThrow());
    expect(a).toEqual({ status: 'failed', error_code: 'sector_pack_disabled' });
    await withSystem('test: settings', (trx) => trx.deleteFrom('loom.loom_settings').where('key', '=', 'platform.enabled_sector_packs').execute());
    await withTenant(s.biz.tenantId, (trx) => trx.updateTable('services').set({ cost_minor: null }).where('id', '=', s.s2).execute());
    await withSystem('test: settings', (trx) => trx.insertInto('loom.loom_settings').values({ key: 'platform.cost_completeness_threshold', value: JSON.stringify(0.95) })
      .onConflict((oc) => oc.column('key').doUpdateSet({ value: JSON.stringify(0.95) })).execute());
    const r2 = await analyzeNow(s.biz.tenantId);
    expect((r2!.quality.checks.find((c) => c.id === 'cost_completeness')!.detail.en)).toMatch(/threshold 95%/);
    await withSystem('test: settings', (trx) => trx.deleteFrom('loom.loom_settings').execute());
  });
});

describe('Loom business setup checklist', () => {
  it('shows every item as required until confirmed; cards name the missing items', async () => {
    const s = await loomSalon();
    const g = await s.owner.call(setup.GET, { params: s.p });
    expect(g.body.data.complete).toBe(false);
    expect(g.body.data.items.map((i: any) => [i.id, i.required, i.confirmed])).toEqual([
      ['goals', true, false], ['monthly_budget', true, false], ['discount_policy', true, false], ['offerings_scope', true, false],
      ['tone', true, false], ['ranking_weights', true, false], ['shared_training_consent', true, false],
    ]);
    await analyzeNow(s.biz.tenantId);
    const before = (await s.owner.call(opps.GET, { params: s.p, headers: { 'accept-language': 'en' } })).body.data;
    expect(before.every((o: any) => o.card.limitations.some((l: string) => /Required settings not confirmed|إعدادات مطلوبة غير مؤكدة/.test(l)))).toBe(true);

    const put = await s.owner.call(setup.PUT, { method: 'PUT', params: s.p, body: {
      goals: [{ kind: 'fill_quiet_times', priority: 'primary' }], monthly_budget_minor: 50000, discount_policy: { no_discounts: false, max_discount_bp: 1000 },
      offerings_scope: { excluded: [], growth: [s.s2] }, tone: { style: 'warm_luxury', banned_words: ['رخيص'] }, ranking_weights: { mode: 'default' }, shared_training_consent: false,
    } });
    expect(put.status).toBe(200);
    expect(put.body.data.setup.complete).toBe(true);
    expect(put.body.data.preferences).toMatchObject({ max_discount_bp: 1000, monthly_budget_minor: 50000, growth_offerings: [s.s2], shared_training_consent: false, weights_source: 'platform_default' });
    await analyzeNow(s.biz.tenantId);
    const after = (await s.owner.call(opps.GET, { params: s.p })).body.data;
    expect(after.some((o: any) => o.card.limitations.some((l: string) => /Required settings|إعدادات مطلوبة/.test(l)))).toBe(false);
    const audit = await withTenant(s.biz.tenantId, (trx) => trx.selectFrom('audit_logs').select('action').where('action', '=', 'loom.setup_confirmed').execute());
    expect(audit).toHaveLength(1);
  });

  it('shared-training consent is owner only; marketing managers can confirm the other items', async () => {
    const s = await loomSalon();
    const manager = await addMember(s.owner, s.biz.slug, 'manager', ['marketing.manage']);
    expect((await manager.call(setup.PUT, { method: 'PUT', params: s.p, body: { tone: { style: 'friendly', banned_words: [] } } })).status).toBe(200);
    const denied = await manager.call(setup.PUT, { method: 'PUT', params: s.p, body: { shared_training_consent: true } });
    expect(denied.status).toBe(403);
    expect(denied.body.error.details.reason).toBe('owner_only');
    expect((await manager.call(profile.PATCH, { method: 'PATCH', params: s.p, body: { facts: { 'consent.shared_training': true } } })).status).toBe(403);
    const plainManager = await addMember(s.owner, s.biz.slug, 'manager');
    expect((await plainManager.call(setup.PUT, { method: 'PUT', params: s.p, body: { tone: { style: 'friendly', banned_words: [] } } })).status).toBe(403);
    expect((await s.owner.call(setup.PUT, { method: 'PUT', params: s.p, body: { shared_training_consent: true } })).body.data.preferences.shared_training_consent).toBe(true);
  });

  it('profile facts: explicit beats computed host preferences; inferred facts are flagged for review; unknown keys are rejected', async () => {
    const s = await loomSalon();
    // The host already holds a marketing preference (computed fact via the connector).
    const mp = await s.owner.call(marketingPrefs.PUT, { method: 'PUT', params: s.p, body: { goals: [], monthly_budget_minor: 70000, max_discount_bp: 3000, tone: null, brand_style: null, channels: [], audience_notes: null, photography_resources: null, schedule_enabled: false, weekly_enabled: true, monthly_enabled: true, weekly_weekday: 0, monthly_day: 1, local_hour: 7, promote_products: true } });
    expect(mp.status).toBe(200);
    await analyzeNow(s.biz.tenantId);
    let p = (await s.owner.call(profile.GET, { params: s.p })).body.data;
    expect(p.preferences.max_discount_bp).toBe(3000);
    expect(p.facts.find((f: any) => f.key === 'pref.max_discount_bp')).toMatchObject({ kind: 'computed', source: { type: 'connector' } });
    expect(p.facts.find((f: any) => f.key === 'identity.sector')).toMatchObject({ kind: 'computed', value: 'beauty' });
    const r = await s.owner.call(prefs.PUT, { method: 'PUT', params: s.p, body: { max_discount_bp: 1000 } });
    expect(r.body.data.preferences.max_discount_bp).toBe(1000);
    // Inferred facts never outrank explicit ones and are flagged.
    await s.owner.call(profile.PATCH, { method: 'PATCH', params: s.p, body: { facts: { 'audience.core': 'young professionals' } } });
    p = (await s.owner.call(profile.GET, { params: s.p })).body.data;
    const facts = p.facts.filter((f: any) => f.key === 'audience.core');
    expect(facts.find((f: any) => f.kind === 'explicit').value).toBe('young professionals');
    for (const f of facts.filter((x: any) => x.kind === 'inferred')) expect(f.needs_review).toBe(true);
    expect((await s.owner.call(profile.PATCH, { method: 'PATCH', params: s.p, body: { facts: { 'pref.made_up': 1 } } })).status).toBe(422);
    expect((await s.owner.call(goals.PUT, { method: 'PUT', params: s.p, body: { goals: [{ kind: 'fill_quiet_times', priority: 'primary' }, { kind: 'sell_products', priority: 'primary' }, { kind: 'improve_reviews', priority: 'primary' }] } })).status).toBe(422);
  });
});
