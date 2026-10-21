import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createBusinessFor, signup } from '../helpers/factory';
import { seedBusiness, cancelLeftoverMarketingJobs } from '../helpers/loom';
import * as sources from '@/app/api/v1/t/[tenantSlug]/marketing/trends/sources/route';
import * as trends from '@/app/api/v1/t/[tenantSlug]/marketing/trends/route';
import * as addToPlan from '@/app/api/v1/t/[tenantSlug]/marketing/trends/[id]/add-to-plan/route';
import * as jobs from '@/app/api/v1/t/[tenantSlug]/marketing/jobs/route';
import * as planOne from '@/app/api/v1/t/[tenantSlug]/marketing/plans/[id]/route';
import { withTenant } from '@/server/db/client';
import { isBlockedIp, safeFetch, SafeFetchError, type FetchResponse, type Transport } from '@/server/domains/marketing/safe-fetch';
import { setTrendFetchForTests } from '@/server/domains/marketing/trends';
import { runAiJob } from '@/server/domains/marketing/pipeline';

afterEach(() => setTrendFetchForTests(undefined));
afterAll(() => cancelLeftoverMarketingJobs());

const body = (s: string): AsyncIterable<Uint8Array> => ({ async *[Symbol.asyncIterator]() { yield Buffer.from(s); } });
const ok = (text: string, ct = 'application/rss+xml'): FetchResponse => ({ status: 200, headers: { 'content-type': ct }, body: body(text) });

function rss(items: Array<{ title: string; days?: number | null; link?: string }>) {
  const now = Date.now();
  return `<?xml version="1.0"?><rss><channel>${items.map((i) => `<item><title><![CDATA[${i.title}]]></title><link>${i.link ?? 'https://news.example.com/x'}</link>${i.days === null ? '' : `<pubDate>${new Date(now - (i.days ?? 1) * 86_400_000).toUTCString()}</pubDate>`}<description>About &amp; more</description></item>`).join('')}</channel></rss>`;
}

const publicResolver = async (host: string) => (host === 'evil.example.com' ? ['10.0.0.5'] : host === 'rebind.example.com' ? ['93.184.216.34', '127.0.0.1'] : ['93.184.216.34']);

describe('SSRF protections', () => {
  it('blocks private, loopback, link-local, metadata and mapped IPv6 addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::', 'fe80::1', 'fd00:ec2::254', 'fc00::1', '::ffff:127.0.0.1', '::ffff:169.254.169.254', '64:ff9b::a9fe:a9fe', '2002:7f00:1::1', '224.0.0.1']) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
    for (const ip of ['93.184.216.34', '8.8.8.8', '2606:4700:4700::1111']) expect(isBlockedIp(ip), ip).toBe(false);
  });

  it('rejects non-https, internal hosts, DNS to private IPs, redirects to internal targets and oversize bodies', async () => {
    const transport: Transport = async (url) => {
      if (url.hostname === 'redir.example.com') return { status: 302, headers: { location: 'https://169.254.169.254/latest/meta-data/' }, body: null };
      if (url.hostname === 'redir2.example.com') return { status: 301, headers: { location: 'http://internal.example.com/' }, body: null };
      if (url.hostname === 'loop.example.com') return { status: 302, headers: { location: 'https://loop.example.com/again' }, body: null };
      if (url.hostname === 'big.example.com') return { status: 200, headers: { 'content-type': 'text/html' }, body: body('x'.repeat(5000)) };
      if (url.hostname === 'bin.example.com') return ok('PK..', 'application/octet-stream');
      return ok(rss([{ title: 'Fine' }]));
    };
    const o = { transport, resolver: publicResolver, maxBytes: 1000 };
    const code = async (u: string) => { try { await safeFetch(u, o); return 'ok'; } catch (e) { return (e as SafeFetchError).code; } };
    expect(await code('http://feeds.example.com/rss')).toBe('invalid_url');
    expect(await code('https://user:pw@feeds.example.com/rss')).toBe('invalid_url');
    expect(await code('https://feeds.example.com:8443/rss')).toBe('invalid_url');
    expect(await code('https://localhost/rss')).toBe('blocked_address');
    expect(await code('https://127.0.0.1/rss')).toBe('blocked_address');
    expect(await code('https://[::ffff:7f00:1]/rss')).toBe('blocked_address');
    expect(await code('https://evil.example.com/rss')).toBe('blocked_address');
    expect(await code('https://rebind.example.com/rss')).toBe('blocked_address');
    expect(await code('https://redir.example.com/rss')).toBe('blocked_address');
    expect(await code('https://redir2.example.com/rss')).toBe('invalid_url');
    expect(await code('https://loop.example.com/rss')).toBe('too_many_redirects');
    expect(await code('https://big.example.com/')).toBe('too_large');
    expect(await code('https://bin.example.com/')).toBe('bad_content_type');
    expect(await code('https://feeds.example.com/rss')).toBe('ok');
  });

  it('refuses to save a source that resolves to an internal address', async () => {
    const owner = await signup('Owner');
    const biz = await createBusinessFor(owner, { plan_code: 'wahaj' });
    setTrendFetchForTests({ resolver: publicResolver, transport: async () => ok(rss([])) });
    const r = await owner.call(sources.POST, { params: { tenantSlug: biz.slug }, body: { kind: 'user_link', name: 'Bad', url: 'https://evil.example.com/page', access_basis: 'provided by owner' } });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('blocked_url');
    const meta = await owner.call(sources.POST, { params: { tenantSlug: biz.slug }, body: { kind: 'user_link', name: 'Meta', url: 'https://169.254.169.254/latest', access_basis: 'x' } });
    expect(meta.status).toBe(422);
  });
});

describe('trend radar', () => {
  it('dedupes, ignores stale/undated items for live signals and never invents evidence strength', async () => {
    const owner = await signup('Owner');
    const biz = await createBusinessFor(owner, { plan_code: 'wahaj' });
    await seedBusiness(biz, { serviceName: 'Keratin hair treatment' });
    const p = { tenantSlug: biz.slug };
    // No sources: honest state.
    expect((await owner.call(trends.GET, { params: p })).body.data.sources_status).toBe('none');
    const feeds: Record<string, string> = {
      'a.example.com': rss([{ title: 'Keratin hair is back', days: 2 }, { title: 'Keratin hair is back', days: 2 }, { title: 'Glossy hair glazing', days: 5 }, { title: 'Old hair news', days: 700 }, { title: 'Undated hair rumour', days: null }]),
      'b.example.com': rss([{ title: 'Hair gloss everywhere', days: 3 }, { title: 'Totally unrelated gardening', days: 1 }]),
      'down.example.com': '',
    };
    setTrendFetchForTests({
      resolver: publicResolver,
      transport: async (url) => (url.hostname === 'down.example.com' ? { status: 503, headers: {}, body: null } : ok(feeds[url.hostname]!)),
    });
    const s1 = await owner.call(sources.POST, { params: p, body: { kind: 'rss', name: 'A', url: 'https://a.example.com/rss', access_basis: 'Public RSS feed' } });
    expect(s1.status).toBe(201);
    expect(s1.body.data.fetch).toMatchObject({ ok: true, stored: 3, duplicates: 1, stale_skipped: 1 });
    // Re-fetching the same feed stores nothing new.
    const again = await owner.call(sources.POST, { params: p, body: { kind: 'rss', name: 'A2', url: 'https://a.example.com/rss?dup=1', access_basis: 'Public RSS feed' } });
    expect(again.body.data.fetch.stored).toBe(3); // a different source keeps its own copy …
    const s2 = await owner.call(sources.POST, { params: p, body: { kind: 'rss', name: 'B', url: 'https://b.example.com/rss', access_basis: 'Public RSS feed' } });
    expect(s2.body.data.fetch.stored).toBe(2);
    const down = await owner.call(sources.POST, { params: p, body: { kind: 'rss', name: 'Down', url: 'https://down.example.com/rss', access_basis: 'Public RSS feed' } });
    expect(down.body.data.fetch).toMatchObject({ ok: false, error: 'http_error' });

    const job = (await owner.call(jobs.POST, { params: p, body: { kind: 'trend_assessment' } })).body.data.job;
    await runAiJob(job.id, biz.tenantId, 1);
    const cards = (await owner.call(trends.GET, { params: p })).body.data;
    expect(cards.sources_status).toBe('connected');
    expect(cards.note).toBe('observations_are_not_verified_news');
    const hair = cards.cards.find((c: any) => c.cluster_key.startsWith('hair'));
    expect(hair).toBeTruthy();
    expect(hair.fit).toBe('good');
    expect(['anecdotal', 'early_signal']).toContain(hair.evidence_strength);
    expect(cards.cards.every((c: any) => c.evidence_strength !== 'quantified')).toBe(true);
    // Duplicate source A2 repeats A's stories: each story counts once.
    expect(hair.observation_ids).toHaveLength(3);
    const titles = hair.observations.map((o: any) => o.title);
    expect(titles).not.toContain('Old hair news');
    expect(titles).not.toContain('Undated hair rumour');
    expect(cards.sources.find((s: any) => s.name === 'Down').status).toBe('error');

    // A single source with one fresh item stays anecdotal.
    const obs = await withTenant(biz.tenantId, (trx) => trx.selectFrom('trend_observations').select(['title', 'evidence_strength', 'published_at']).execute());
    expect(obs.every((o) => o.evidence_strength === 'anecdotal')).toBe(true);
    expect(obs.find((o) => o.title === 'Undated hair rumour')!.published_at).toBeNull();

    // "Add to weekly plan" needs a weekly plan and appends a new version.
    expect((await owner.call(addToPlan.POST, { params: { ...p, id: hair.id } })).status).toBe(409);
    const wj = (await owner.call(jobs.POST, { params: p, body: { kind: 'weekly_plan', mode: 'rules' } })).body.data.job;
    await runAiJob(wj.id, biz.tenantId, 1, 'rules');
    const planId = (await withTenant(biz.tenantId, (trx) => trx.selectFrom('ai_jobs').select('result_ref').where('id', '=', wj.id).executeTakeFirstOrThrow())).result_ref as any;
    const added = await owner.call(addToPlan.POST, { params: { ...p, id: hair.id } });
    expect(added.status).toBe(200);
    const plan = (await owner.call(planOne.GET, { params: { ...p, id: planId.plan_id } })).body.data;
    expect(plan.versions[0].change_note).toBe('trend_added');
    expect(plan.versions).toHaveLength(2);
  });
});
