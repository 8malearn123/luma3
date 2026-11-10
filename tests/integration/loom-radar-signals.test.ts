import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { withSystem, withTenant } from '@/server/db/client';
import { analyzeNow, assessClusters, setRadarFetcher, sweepSources, timingContextFor } from '@/loom';
import * as radar from '@/app/api/v1/t/[tenantSlug]/loom/radar/route';
import * as sources from '@/app/api/v1/t/[tenantSlug]/loom/radar/sources/route';
import * as sourceOne from '@/app/api/v1/t/[tenantSlug]/loom/radar/sources/[id]/route';
import * as fetchNow from '@/app/api/v1/t/[tenantSlug]/loom/radar/sources/[id]/fetch/route';
import * as cluster from '@/app/api/v1/t/[tenantSlug]/loom/radar/clusters/[id]/route';
import * as opps from '@/app/api/v1/t/[tenantSlug]/loom/opportunities/route';
import * as timing from '@/app/api/v1/t/[tenantSlug]/loom/opportunities/[id]/timing/route';
import { lumaRadarFetcher } from '@/server/loom-host/radar';
import { cancelLeftoverMarketingJobs } from '../helpers/loom';
import { loomSalon } from '../helpers/loom-core';
import { ok, rss, useFakeRadar } from '../helpers/loom-radar';

afterEach(() => setRadarFetcher(lumaRadarFetcher()));
afterAll(async () => {
  await cancelLeftoverMarketingJobs();
  await withSystem('test cleanup', (trx) => trx.updateTable('job_runs').set({ status: 'cancelled' }).where('status', '=', 'queued').where('kind', '=', 'loom.analysis').execute());
});

const FEED_A = 'https://feeds.example.com/a.xml';
const FEED_B = 'https://feeds.example.com/b.xml';
const add = (s: Awaited<ReturnType<typeof loomSalon>>, body: Record<string, unknown>) => s.owner.call(sources.POST, { params: s.p, body: { access_basis: 'public RSS feed', ...body } });
const view = async (s: Awaited<ReturnType<typeof loomSalon>>) => (await s.owner.call(radar.GET, { params: s.p })).body.data;

describe('Loom radar: sources, dedupe, clusters and evidence classes', () => {
  it('stores untrusted signals once, clusters related ones, classes evidence, explains relevance and links an internal opportunity', async () => {
    const s = await loomSalon();
    await analyzeNow(s.biz.tenantId);
    const facialOpp = ((await s.owner.call(opps.GET, { params: s.p })).body.data as any[]).find((o) => o.detector_id === 'high_satisfaction_low_demand');
    expect(facialOpp).toBeTruthy();
    useFakeRadar({
      [FEED_A]: () => ok(rss([{ title: 'Glow facial is the season’s favourite', days: 2 }, { title: 'Facial routines for winter skin', days: 5 }, { title: 'Old keratin story', days: 60 }, { title: 'Undated facial post', days: null }])),
      [FEED_B]: () => ok(rss([{ title: 'Glow facial is the season’s favourite', days: 1 }, { title: 'Skin serum launch week', days: 3 }])),
    });
    const a = await add(s, { kind: 'rss', name: 'Feed A', url: FEED_A });
    expect(a.status).toBe(201);
    expect(a.body.data.fetch).toMatchObject({ ok: true, stored: 4, duplicates: 0 });
    const b = await add(s, { kind: 'rss', name: 'Feed B', url: FEED_B });
    expect(b.body.data.fetch).toMatchObject({ ok: true, stored: 2 });

    // Re-fetch: nothing new is stored (per-source content hash); the syndicated story is marked duplicate_of.
    const again = await s.owner.call(fetchNow.POST, { params: { ...s.p, id: a.body.data.source.id } });
    expect(again.body.data.fetch).toMatchObject({ ok: true, stored: 0, duplicates: 4 });
    const dup = await withTenant(s.biz.tenantId, (trx) => trx.selectFrom('loom.signals').select(['untrusted_title', 'duplicate_of']).where('business_id', '=', s.biz.tenantId).where('duplicate_of', 'is not', null).execute());
    expect(dup.map((d) => d.untrusted_title)).toEqual(['Glow facial is the season’s favourite']);

    const d = await view(s);
    expect(d.note).toBe('signals_are_not_verified_news');
    expect(d.external_status).toBe('connected');
    const skin = d.clusters.find((c: any) => c.topic === 'skin');
    // 3 distinct live stories (the syndicated one counts once) from 2 sources ⇒ early signal; no numbers ⇒ never a supported trend.
    // The undated facial post joins the cluster by topic but is not live and is not counted as live evidence.
    expect(skin).toMatchObject({ evidence_class: 'early_signal', liveness: 'live', signal_count: 4, live_count: 3, source_count: 2 });
    expect(skin.signals.find((x: any) => /Undated/.test(x.untrusted_title))).toMatchObject({ freshness: 'unknown', live: false });
    expect(skin.relevance.score).toBeGreaterThan(0.5);
    expect(skin.relevance.reasons.length).toBe(4);
    expect(skin.suggested_opportunity).toMatchObject({ id: facialOpp.card.opportunity_id });
    expect(skin.signals.every((x: any) => x.url.startsWith('https://') && x.source_name && x.cluster_id === skin.id)).toBe(true);
    expect(skin.signals.find((x: any) => x.untrusted_summary)?.untrusted_summary).toMatch(/ignore previous instructions/); // stored as untrusted data, never acted on

    // T7: the 60-day-old item and the undated one are never live; shown as stale.
    expect(d.clusters.some((c: any) => /Old keratin|Undated/.test(c.untrusted_label))).toBe(false);
    const stale = d.stale.find((c: any) => /Old keratin/.test(c.untrusted_label));
    expect(stale).toMatchObject({ liveness: 'stale', relevance: null, suggested_opportunity: null });
    expect(stale.signals[0].freshness).toBe('stale');
    const attachStale = await s.owner.call(cluster.POST, { params: { ...s.p, id: stale.id }, body: { action: 'attach', opportunity_id: facialOpp.card.opportunity_id } });
    expect(attachStale.status).toBe(409);
    expect(attachStale.body.error.code).toBe('signal_stale');

    // P1: attach only to an EXISTING internal opportunity.
    const ghost = await s.owner.call(cluster.POST, { params: { ...s.p, id: skin.id }, body: { action: 'attach', opportunity_id: '00000000-0000-4000-8000-000000000000' } });
    expect(ghost.status).toBe(404);
    const att = await s.owner.call(cluster.POST, { params: { ...s.p, id: skin.id }, body: { action: 'attach', opportunity_id: facialOpp.card.opportunity_id } });
    expect(att.status).toBe(200);
    const after = await view(s);
    expect(after.clusters.find((c: any) => c.id === skin.id)).toMatchObject({ status: 'attached', attached_opportunity: { id: facialOpp.card.opportunity_id } });
    const tc = (await s.owner.call(timing.GET, { params: { ...s.p, id: facialOpp.card.opportunity_id } })).body.data;
    expect(tc.signals).toEqual([expect.objectContaining({ cluster_id: skin.id, evidence_class: 'early_signal', attached: true, sources: expect.arrayContaining(['Feed A', 'Feed B']) })]);
    expect(tc.rules).toMatchObject({ standalone_campaign_allowed: false, unverified_dates_usable: false, competitor_price_decrease_allowed: false });

    // Add to plan: through LUMA's ActionPort (a plan version), never a campaign.
    const plan = await s.owner.call(cluster.POST, { params: { ...s.p, id: skin.id }, body: { action: 'add_to_plan' } });
    expect(plan.status).toBe(201);
    expect(plan.body.data.result.target).toBe('plan_action');
    const versions = await withTenant(s.biz.tenantId, (trx) => trx.selectFrom('plan_versions').select(['content']).where('plan_id', '=', plan.body.data.result.ref_id).execute());
    expect(JSON.stringify(versions.at(-1)!.content)).toMatch(/External signal \(unverified\)|إشارة خارجية/);
    expect(await withTenant(s.biz.tenantId, (trx) => trx.selectFrom('campaigns').select('id').execute())).toHaveLength(0);

    // Dismiss detaches; re-clustering keeps the decision.
    await s.owner.call(cluster.POST, { params: { ...s.p, id: skin.id }, body: { action: 'dismiss' } });
    await assessClusters(s.biz.tenantId);
    const v3 = await view(s);
    expect(v3.clusters.some((c: any) => c.id === skin.id)).toBe(false);
    expect(v3.dismissed.find((c: any) => c.id === skin.id).status).toBe('dismissed');
    expect((await timingContextFor(s.biz.tenantId, facialOpp.card.opportunity_id)).signals).toEqual([]);
  });

  it('refuses internal addresses; an unconfigured API source is «disconnected» and analysis continues on internal data', async () => {
    const s = await loomSalon();
    useFakeRadar({});
    const bad = await add(s, { kind: 'rss', name: 'Internal', url: 'https://feed.internal-ip.example/rss' });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('blocked_url');
    expect((await add(s, { kind: 'rss', name: 'Plain http', url: 'http://feeds.example.com/x' })).status).toBe(422);
    expect((await add(s, { kind: 'api', name: 'Nope', provider: 'no_such_provider' })).status).toBe(422);

    const api = await add(s, { kind: 'api', name: 'Search interest', provider: 'search_interest', query: { q: 'facial' }, access_basis: 'licensed API' });
    expect(api.status).toBe(201);
    expect(api.body.data.source).toMatchObject({ status: 'disconnected', connection: 'disconnected', connection_reason: 'not_configured' });
    expect(api.body.data.fetch).toMatchObject({ ok: false, error: 'not_configured' });
    const d = await view(s);
    expect(d.external_status).toBe('all_unavailable');
    expect(d.providers.find((p: any) => p.id === 'search_interest').status).toEqual({ state: 'disconnected', reason: 'not_configured' });
    const r = await analyzeNow(s.biz.tenantId);
    expect(r!.status).toBe('succeeded');
    expect((r!.result as any).opportunities).toBeGreaterThan(0);
  });

  it('a configured API provider: only the numbers it supplies make a supported trend', async () => {
    const s = await loomSalon();
    process.env.LOOM_RADAR_SEARCH_INTEREST_URL = 'https://api.example.com/interest';
    try {
      useFakeRadar({ 'https://api.example.com/interest?q=facial': () => ok(JSON.stringify({ items: [{ title: 'Facial searches', url: 'https://api.example.com/t/1', published_at: new Date(Date.now() - 86_400_000).toISOString(), metrics: { search_index: 72 } }] }), 'application/json') });
      const api = await add(s, { kind: 'api', name: 'Search interest', provider: 'search_interest', query: { q: 'facial' }, access_basis: 'licensed API' });
      expect(api.body.data.source.connection).toBe('connected');
      expect(api.body.data.fetch).toMatchObject({ ok: true, stored: 1 });
      const c = (await view(s)).clusters[0];
      expect(c.evidence_class).toBe('supported_trend');
      expect(c.signals[0].reach_metrics).toEqual({ search_index: 72 });
    } finally { delete process.env.LOOM_RADAR_SEARCH_INTEREST_URL; }
  });

  it('periodic sweep: due sources only, exponential backoff on failure, idempotent re-runs', async () => {
    const s = await loomSalon();
    let down = true;
    useFakeRadar({ [FEED_A]: () => (down ? { status: 503, headers: { 'content-type': 'text/plain' }, body: null } : ok(rss([{ title: 'Nail art week', days: 1 }]))) });
    const a = await add(s, { kind: 'rss', name: 'Feed A', url: FEED_A });
    expect(a.body.data.fetch).toMatchObject({ ok: false, error: 'http_error' });
    const src = () => withTenant(s.biz.tenantId, (trx) => trx.selectFrom('loom.signal_sources').selectAll().where('id', '=', a.body.data.source.id).executeTakeFirstOrThrow());
    const s1 = await src();
    expect(s1).toMatchObject({ status: 'error', consecutive_failures: 1 });
    expect(s1.next_fetch_at.getTime() - s1.last_fetched_at!.getTime()).toBe(3_600_000);
    // Not due yet: the sweep leaves it alone.
    await sweepSources(new Date());
    expect((await src()).consecutive_failures).toBe(1);
    await sweepSources(new Date(Date.now() + 3_700_000));
    const s2 = await src();
    expect(s2.consecutive_failures).toBe(2);
    expect(s2.next_fetch_at.getTime() - s2.last_fetched_at!.getTime()).toBe(7_200_000);
    down = false;
    await sweepSources(new Date(Date.now() + 3 * 3_700_000));
    expect(await src()).toMatchObject({ status: 'active', consecutive_failures: 0 });
    await sweepSources(new Date(Date.now() + 30 * 3_700_000));
    const n = await withTenant(s.biz.tenantId, (trx) => trx.selectFrom('loom.signals').select('id').where('business_id', '=', s.biz.tenantId).execute());
    expect(n).toHaveLength(1);
    expect((await view(s)).clusters.find((c: any) => c.topic === 'nails')).toBeTruthy();
  });

  it('tenant isolation: another business sees none of the signals and cannot touch the sources or attach to them', async () => {
    const s = await loomSalon();
    const other = await loomSalon({ name: 'Other Owner' });
    await analyzeNow(other.biz.tenantId);
    useFakeRadar({ [FEED_A]: () => ok(rss([{ title: 'Henna nights', days: 1 }])) });
    const a = await add(s, { kind: 'rss', name: 'Feed A', url: FEED_A });
    const mine = (await view(s)).clusters[0];
    expect(mine).toBeTruthy();
    const theirs = await view(other);
    expect(theirs.clusters).toEqual([]);
    expect(theirs.sources).toEqual([]);
    expect((await other.owner.call(sourceOne.PATCH, { params: { ...other.p, id: a.body.data.source.id }, body: { status: 'disabled' } })).status).toBe(404);
    expect((await other.owner.call(cluster.POST, { params: { ...other.p, id: mine.id }, body: { action: 'dismiss' } })).status).toBe(404);
    // Their opportunity cannot be attached from my business.
    const theirOpp = ((await other.owner.call(opps.GET, { params: other.p })).body.data as any[])[0];
    expect((await s.owner.call(cluster.POST, { params: { ...s.p, id: mine.id }, body: { action: 'attach', opportunity_id: theirOpp.card.opportunity_id } })).status).toBe(404);
    // Raw RLS: in their scope my rows do not exist.
    expect(await withTenant(other.biz.tenantId, (trx) => trx.selectFrom('loom.signals').select('id').execute())).toHaveLength(0);
  });

  it('signals are append-only', async () => {
    const s = await loomSalon();
    useFakeRadar({ [FEED_A]: () => ok(rss([{ title: 'Lash lift', days: 1 }])) });
    await add(s, { kind: 'rss', name: 'Feed A', url: FEED_A });
    await expect(withTenant(s.biz.tenantId, (trx) => trx.updateTable('loom.signals').set({ untrusted_title: 'x' }).execute())).rejects.toThrow();
  });
});
