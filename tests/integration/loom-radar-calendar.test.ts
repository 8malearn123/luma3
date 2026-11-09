import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { withSystem, withTenant } from '@/server/db/client';
import { analyzeNow, importDueOfficialSources, platformSettingsSchema, setRadarFetcher, timingContextFor } from '@/loom';
import { addDays } from '@/loom/util/time';
import * as platformCal from '@/app/api/v1/platform/loom/calendar/route';
import * as platformCalOne from '@/app/api/v1/platform/loom/calendar/[id]/route';
import * as calendar from '@/app/api/v1/t/[tenantSlug]/loom/radar/calendar/route';
import * as calendarOne from '@/app/api/v1/t/[tenantSlug]/loom/radar/calendar/[id]/route';
import * as opps from '@/app/api/v1/t/[tenantSlug]/loom/opportunities/route';
import { lumaRadarFetcher } from '@/server/loom-host/radar';
import { createBusinessFor, signup } from '../helpers/factory';
import { cancelLeftoverMarketingJobs } from '../helpers/loom';
import { loomSalon } from '../helpers/loom-core';
import { expireStepUp, platformUser, stepUp } from '../helpers/platform';
import { ok, useFakeRadar } from '../helpers/loom-radar';

afterEach(() => setRadarFetcher(lumaRadarFetcher()));
afterAll(async () => {
  await cancelLeftoverMarketingJobs();
  await withSystem('test cleanup', async (trx) => {
    await trx.updateTable('job_runs').set({ status: 'cancelled' }).where('status', '=', 'queued').where('kind', '=', 'loom.analysis').execute();
    await trx.deleteFrom('loom.calendar_choices').execute();
    await trx.deleteFrom('loom.platform_calendar_events').execute();
    await trx.deleteFrom('loom.official_source_state').execute();
    await trx.deleteFrom('loom.loom_settings').execute();
  });
});

const today = () => new Date().toISOString().slice(0, 10);
const ymd = (d: string) => d.replaceAll('-', '');
type Ev = { key: string; kind: string; region?: string; starts: number; needs?: boolean; basis?: string; title?: string; topics?: string[] };
async function platformEvent(e: Ev) {
  return withSystem('test: platform event', async (trx) => (await trx.insertInto('loom.platform_calendar_events').values({
    event_key: `test:${e.key}:${Math.random().toString(36).slice(2, 8)}`, origin: 'starter', source_name: 'Test authority', kind: e.kind, region: e.region ?? 'SA',
    title_ar: e.title ?? e.key, title_en: e.title ?? e.key, starts_on: addDays(today(), e.starts), ends_on: addDays(today(), e.starts),
    date_basis: e.basis ?? (e.needs ? 'lunar_estimate' : 'fixed_gregorian'), needs_verification: !!e.needs, topics: e.topics ?? [],
  }).returning('id').executeTakeFirstOrThrow()).id);
}
const cal = async (s: { owner: any; p: any }) => (await s.owner.call(calendar.GET, { params: s.p })).body.data as any[];
const act = (s: { owner: any; p: any }, id: string, body: Record<string, unknown>) => s.owner.call(calendarOne.POST, { params: { ...s.p, id }, body });
const fingerprints = async (tenantId: string) => (await withTenant(tenantId, (trx) => trx.selectFrom('loom.opportunities').select(['fingerprint', 'status']).where('business_id', '=', tenantId).execute()))
  .filter((o) => !['expired', 'superseded'].includes(o.status)).map((o) => o.fingerprint).sort();

describe('Platform calendar management (platform owner only)', () => {
  it('only the platform owner reads and manages it; imports and reviews need step-up', async () => {
    const owner = await platformUser('platform_owner');
    const support = await platformUser('support_admin');
    const stranger = await signup('Calendar Stranger');
    const biz = await loomSalon();
    expect((await stranger.call(platformCal.GET)).status).toBe(404);
    expect((await support.call(platformCal.GET)).status).toBe(404);
    expect((await biz.owner.call(platformCal.GET)).status).toBe(404);
    expect((await biz.owner.call(platformCal.POST, { body: { target: 'starter' } })).status).toBe(404);
    await expireStepUp(owner.identifier);
    expect((await owner.call(platformCal.POST, { body: { target: 'starter' } })).status).toBe(401);
    await stepUp(owner);
    const st = await owner.call(platformCal.POST, { body: { target: 'starter' } });
    expect(st.status).toBe(200);
    expect(st.body.data.starter_inserted).toBeGreaterThan(10);
    expect((await owner.call(platformCal.POST, { body: { target: 'starter' } })).body.data.starter_inserted).toBe(0); // idempotent
    const g = await owner.call(platformCal.GET);
    expect(g.status).toBe(200);
    const eid = g.body.data.events.find((e: any) => e.event_key === 'starter:sa:eid_al_fitr:1448');
    expect(eid).toMatchObject({ verification: 'needs_verification', date_basis: 'lunar_estimate', untrusted: false });
    expect(g.body.data.events.find((e: any) => e.event_key === 'starter:sa:national_day:2027')).toMatchObject({ verification: 'verified' });
    // A business owner cannot review platform events.
    expect((await biz.owner.call(platformCalOne.PATCH, { params: { id: eid.id }, body: { action: 'withdraw' } })).status).toBe(404);
    expect((await owner.call(platformCalOne.PATCH, { params: { id: eid.id }, body: { action: 'verify', note: 'x' } })).status).toBe(422);
    const v = await owner.call(platformCalOne.PATCH, { params: { id: eid.id }, body: { action: 'verify', note: 'Supreme Court announcement', starts_on: '2027-03-09', ends_on: '2027-03-12' } });
    expect(v.body.data).toMatchObject({ verification: 'verified', date_basis: 'platform_verified', starts_on: '2027-03-09', ends_on: '2027-03-12' });
    const audit = await withSystem('test', (trx) => trx.selectFrom('audit_logs').select('action').where('action', '=', 'loom.calendar_event_reviewed').execute());
    expect(audit.length).toBeGreaterThanOrEqual(1);
  });

  it('imports official sources through safe-fetch (mocked): untrusted titles, attribution, health topics, backoff, idempotent', async () => {
    const owner = await platformUser('platform_owner', 'Cal Owner 2');
    await stepUp(owner);
    const d1 = addDays(today(), 20), d2 = addDays(today(), 40);
    const ics = `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:gov-1\r\nDTSTART;VALUE=DATE:${ymd(d1)}\r\nDTEND;VALUE=DATE:${ymd(addDays(d1, 2))}\r\nSUMMARY:إجازة رسمية تجريبية\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:gov-2\r\nDTSTART;VALUE=DATE:${ymd(d2)}\r\nSUMMARY:اليوم العالمي للسكري (تجربة)\r\nEND:VEVENT\r\nEND:VCALENDAR`;
    const { calls } = useFakeRadar({
      'https://calendar.example.gov.sa/feed.ics': () => ok(ics, 'text/calendar'),
      'https://community.example.com/c.json': () => ok(JSON.stringify({ events: [{ uid: 'c1', title: 'Local market night <script>x</script>', starts_on: d1, region: 'SA:riyadh' }] }), 'application/json'),
    });
    // Written directly (the audited PUT path is covered by loom-settings.test.ts; this keeps its audit count exact).
    const sourcesValue = platformSettingsSchema.shape.event_sources.parse([
      { id: 'sa-gov', name: 'Official calendar', url: 'https://calendar.example.gov.sa/feed.ics', region: 'SA', kind: 'official_calendar', license_note: 'public', enabled: true },
      { id: 'community', name: 'Community calendar', url: 'https://community.example.com/c.json', region: 'SA', kind: 'other', license_note: 'permission', enabled: true },
      { id: 'bad-src', name: 'Bad', url: 'https://cal.internal-ip.example/x.ics', region: 'SA', kind: 'official_calendar', license_note: '-', enabled: true },
    ]);
    await withSystem('test: sources', (trx) => trx.insertInto('loom.loom_settings').values({ key: 'platform.event_sources', value: JSON.stringify(sourcesValue) })
      .onConflict((oc) => oc.column('key').doUpdateSet({ value: JSON.stringify(sourcesValue) })).execute());
    const r = await owner.call(platformCal.POST, { body: { target: 'sources' } });
    expect(r.body.data.results).toEqual([
      expect.objectContaining({ id: 'sa-gov', ok: true, imported: 2 }),
      expect.objectContaining({ id: 'community', ok: true, imported: 1 }),
      expect.objectContaining({ id: 'bad-src', ok: false, error: 'blocked_address' }),
    ]);
    expect(calls.some((u) => u.includes('internal-ip'))).toBe(false); // refused before any connection
    const ev = await withSystem('t', (trx) => trx.selectFrom('loom.platform_calendar_events').selectAll().where('origin', '=', 'official_source').orderBy('starts_on').execute());
    const gov1 = ev.find((e) => e.source_ref === 'gov-1')!;
    expect(gov1).toMatchObject({ source_id: 'sa-gov', source_name: 'Official calendar', source_url: 'https://calendar.example.gov.sa/feed.ics', title_ar: null, untrusted_title: 'إجازة رسمية تجريبية',
      starts_on: d1, ends_on: addDays(d1, 1), kind: 'national', date_basis: 'official_source', needs_verification: false, region: 'SA' });
    expect(ev.find((e) => e.source_ref === 'gov-2')).toMatchObject({ kind: 'health_awareness', topics: ['diabetes_day'] });
    // A non-official registry entry is imported but needs verification; scripts are stripped.
    expect(ev.find((e) => e.source_id === 'community')).toMatchObject({ needs_verification: true, region: 'SA:riyadh', untrusted_title: 'Local market night' });
    const bad = await withSystem('t', (trx) => trx.selectFrom('loom.official_source_state').selectAll().where('source_id', '=', 'bad-src').executeTakeFirstOrThrow());
    expect(bad).toMatchObject({ status: 'error', last_error: 'blocked_address', consecutive_failures: 1 });
    expect(bad.next_fetch_at.getTime() - bad.last_fetched_at!.getTime()).toBe(3_600_000);
    // Periodic re-run: nothing is due (24 h after success, 1 h backoff); after that the unchanged file imports nothing new.
    expect(await importDueOfficialSources(new Date())).toEqual([]);
    const later = await importDueOfficialSources(new Date(Date.now() + 25 * 3_600_000));
    expect(later.map((x) => x.id)).toEqual(['sa-gov', 'community', 'bad-src']);
    const n = await withSystem('t', (trx) => trx.selectFrom('loom.platform_calendar_events').select('id').where('origin', '=', 'official_source').execute());
    expect(n).toHaveLength(3);
    expect((await withSystem('t', (trx) => trx.selectFrom('loom.official_source_state').select('consecutive_failures').where('source_id', '=', 'bad-src').executeTakeFirstOrThrow())).consecutive_failures).toBe(2);
    await withSystem('test: sources', (trx) => trx.deleteFrom('loom.loom_settings').where('key', '=', 'platform.event_sources').execute());
  });
});

describe('Business calendar, adoption and P1 timing', () => {
  it('needs_verification is never shown or used as verified; other cities are left out; owner adopts and hides', async () => {
    const s = await loomSalon();
    await analyzeNow(s.biz.tenantId);
    const lunar = await platformEvent({ key: 'lunar', kind: 'religious', starts: 3, needs: true });
    const fixed = await platformEvent({ key: 'fixed', kind: 'national', starts: 9 });
    const jeddah = await platformEvent({ key: 'jeddah', kind: 'local_event', region: 'SA:jeddah', starts: 4 });
    const list = await cal(s);
    expect(list.find((e) => e.id === lunar)).toMatchObject({ verification: 'needs_verification', date_basis: 'lunar_estimate', choice: null });
    expect(list.find((e) => e.id === fixed)).toMatchObject({ verification: 'verified' });
    expect(list.some((e) => e.id === jeddah)).toBe(false);
    expect(list.find((e) => e.id === fixed).relevance.reasons.length).toBe(4);

    const promo = ((await s.owner.call(opps.GET, { params: s.p })).body.data as any[]).find((o) => o.detector_id === 'high_satisfaction_low_demand');
    // Unverified dates cannot set timing.
    const r = await act(s, lunar, { action: 'attach', opportunity_id: promo.card.opportunity_id });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('needs_verification');
    // Adopted but unverified: the engine skips it; the verified adopted one times the EXISTING opportunity.
    expect((await act(s, lunar, { action: 'adopt' })).body.data.choice).toBe('adopted');
    expect((await act(s, fixed, { action: 'adopt' })).status).toBe(200);
    await analyzeNow(s.biz.tenantId);
    const after = ((await s.owner.call(opps.GET, { params: s.p })).body.data as any[]).find((o) => o.card.opportunity_id === promo.card.opportunity_id);
    expect(after.card.timing.event_ref).toBe(`platform:${fixed}`);
    const tc = await timingContextFor(s.biz.tenantId, promo.card.opportunity_id);
    expect(tc.events.find((e) => e.ref === `platform:${lunar}`)).toMatchObject({ verification: 'needs_verification', usable_for_dates: false });
    expect(tc.events.find((e) => e.ref === `platform:${fixed}`)).toMatchObject({ verification: 'verified', usable_for_dates: true });
    // Hide removes it from timing.
    await act(s, fixed, { action: 'hide' });
    expect((await cal(s)).find((e) => e.id === fixed).choice).toBe('hidden');
    expect((await timingContextFor(s.biz.tenantId, promo.card.opportunity_id)).events.some((e) => e.ref === `platform:${fixed}`)).toBe(false);
  });

  it('T8: an event without an internal opportunity creates no opportunity; with one, only the existing ones are timed', async () => {
    // A business with no data at all: adopting an event produces nothing.
    const owner = await signup('Empty Owner');
    const empty = await createBusinessFor(owner, { plan_code: 'wahaj' });
    const ev = await platformEvent({ key: 'national', kind: 'national', starts: 6 });
    expect((await owner.call(calendarOne.POST, { params: { tenantSlug: empty.slug, id: ev }, body: { action: 'adopt' } })).status).toBe(200);
    const r = await analyzeNow(empty.tenantId);
    expect(r!.status).toBe('insufficient_data');
    expect(await fingerprints(empty.tenantId)).toEqual([]);

    const s = await loomSalon();
    await analyzeNow(s.biz.tenantId);
    const before = await fingerprints(s.biz.tenantId);
    await act(s, ev, { action: 'adopt' });
    await analyzeNow(s.biz.tenantId);
    expect(await fingerprints(s.biz.tenantId)).toEqual(before);
    const rows = await withTenant(s.biz.tenantId, (trx) => trx.selectFrom('loom.opportunities').select(['category', 'card']).execute());
    expect(rows.some((o) => (o.card as any).timing.event_ref === `platform:${ev}`)).toBe(true);
    expect(rows.every((o) => !/seasonal/.test(o.category))).toBe(true);
    // Attaching to a non-existent opportunity is refused.
    expect((await act(s, ev, { action: 'attach', opportunity_id: '00000000-0000-4000-8000-000000000000' })).status).toBe(404);
  });

  it('awareness-only health days: awareness framing, never tied to a discount', async () => {
    const s = await loomSalon();
    await analyzeNow(s.biz.tenantId);
    const health = await platformEvent({ key: 'health', kind: 'world_day', region: 'GLOBAL', starts: 5, topics: ['diabetes_day'] });
    expect((await cal(s)).find((e) => e.id === health).awareness_only).toBe(true);
    await act(s, health, { action: 'adopt' });
    await analyzeNow(s.biz.tenantId);
    const list = (await s.owner.call(opps.GET, { params: s.p })).body.data as any[];
    const timed = list.find((o) => o.card.timing.event_ref === `platform:${health}:awareness_only`);
    expect(timed).toBeTruthy();
    expect(timed.card.assumptions.join(' ')).toMatch(/توعوية فقط|Awareness framing only/);
    expect(timed.card.recommended_action.kind).not.toBe('limited_discount');

    // A discount opportunity cannot be tied to it.
    const target = list.find((o) => o.card.opportunity_id !== timed.card.opportunity_id && o.bucket !== 'blocked') ?? timed;
    await withTenant(s.biz.tenantId, async (trx) => {
      const row = await trx.selectFrom('loom.opportunities').select('card').where('id', '=', target.card.opportunity_id).executeTakeFirstOrThrow();
      const card = row.card as any;
      card.recommended_action = { ...card.recommended_action, kind: 'limited_discount', discount_bp: 1000 };
      await trx.updateTable('loom.opportunities').set({ card: JSON.stringify(card) }).where('id', '=', target.card.opportunity_id).execute();
    });
    const r = await act(s, health, { action: 'attach', opportunity_id: target.card.opportunity_id });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('awareness_discount_coupling');
    const ok2 = await act(s, health, { action: 'attach', opportunity_id: timed.card.opportunity_id });
    expect(ok2.body.data).toMatchObject({ attached: true, framing: 'awareness_only' });
    const tc = await timingContextFor(s.biz.tenantId, timed.card.opportunity_id);
    expect(tc.rules.awareness_only_refs).toContain(`platform:${health}`);
    expect(tc.notes.some((n) => /Awareness framing only/.test(n.en))).toBe(true);
  });

  it('tenant isolation of choices and attachments', async () => {
    const a = await loomSalon();
    const b = await loomSalon({ name: 'Iso B' });
    await analyzeNow(a.biz.tenantId);
    const ev = await platformEvent({ key: 'iso', kind: 'national', starts: 8 });
    await act(a, ev, { action: 'adopt' });
    expect((await cal(b)).find((e) => e.id === ev).choice).toBeNull();
    const aOpp = ((await a.owner.call(opps.GET, { params: a.p })).body.data as any[])[0];
    expect((await act(b, ev, { action: 'attach', opportunity_id: aOpp.card.opportunity_id })).status).toBe(404);
    expect(await withTenant(b.biz.tenantId, (trx) => trx.selectFrom('loom.calendar_choices').select('event_id').execute())).toEqual([]);
  });
});
