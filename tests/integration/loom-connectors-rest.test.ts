import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withSystem, withTenant } from '@/server/db/client';
import { configureLumaLoomRuntime } from '@/server/loom-host/runtime';
import type { FetchResponse, Transport } from '@/server/domains/marketing/safe-fetch';
import { runDueJobs } from '@/server/jobs/runner';
import {
  analyzeNow, deliverWebhook, emitLoomEvent, loadDataset, connectorFor, loomBusinesses, loomConnections, loomWebhooks, parseCsv, signBody, verifySignature,
} from '@/loom';
import * as ingest from '@/app/api/v1/loom/ingest/[connection]/route';
import * as conns from '@/app/api/v1/t/[tenantSlug]/loom/connections/route';
import * as connOne from '@/app/api/v1/t/[tenantSlug]/loom/connections/[id]/route';
import * as hooks from '@/app/api/v1/t/[tenantSlug]/loom/webhooks/route';
import * as decision from '@/app/api/v1/t/[tenantSlug]/loom/opportunities/[id]/decision/route';
import * as opps from '@/app/api/v1/t/[tenantSlug]/loom/opportunities/route';
import * as packRoute from '@/app/api/v1/t/[tenantSlug]/loom/sector-pack/route';
import { enableRetailPack, RETAIL_MAPPING, retailCsv } from '../helpers/loom-retail';
import { loomSalon } from '../helpers/loom-core';

/**
 * Phase 7: REST pull connector (through the SSRF-safe fetcher), signed
 * inbound webhooks, outgoing webhooks (signing, retries, delivery log) and
 * secret handling.
 */
const actor = { userId: null, kind: 'platform' as const };
const ctx = (businessId: string) => ({ businessId, actor, locale: 'en' as const });
const SECRET = 'sk_live_super_secret_value_123';

type Seen = { url: string; method: string; headers: Record<string, string>; body?: string };
let seen: Seen[] = [];
let respond: (u: URL, init: { method?: string; body?: string }) => { status: number; json?: unknown; text?: string } = () => ({ status: 404 });

const transport: Transport = async (url, init) => {
  seen.push({ url: url.toString(), method: init.method ?? 'GET', headers: init.headers, body: init.body });
  const r = respond(url, init);
  const text = r.text ?? JSON.stringify(r.json ?? {});
  const res: FetchResponse = { status: r.status, headers: { 'content-type': 'application/json' }, body: (async function* () { yield Buffer.from(text); })() };
  return res;
};
const resolver = async (host: string) => (host === 'rebind.store.example' ? ['10.0.0.5'] : ['93.184.216.34']);

const rows = (csv: string) => parseCsv(csv).rows;

beforeAll(async () => {
  configureLumaLoomRuntime({ transport, resolver });
  await enableRetailPack();
});
beforeEach(() => { seen = []; });
afterAll(async () => {
  configureLumaLoomRuntime();
  await withSystem('test: reset loom settings', (trx) => trx.deleteFrom('loom.loom_settings').execute());
  await withSystem('test cleanup', (trx) => trx.updateTable('job_runs').set({ status: 'cancelled' }).where('status', '=', 'queued').execute());
});

const restConfig = (base = 'https://api.store.example/v1') => ({
  base_url: base, health_path: '/health', items_field: 'data',
  paths: { offerings: '/products', inventory_items: '/stock', transactions: '/orders', transaction_lines: '/order-lines', customers: '/customers', resources: '/resources', capacity_windows: '/shifts' },
  pagination: { type: 'cursor' as const, cursor_param: 'cursor', next_field: 'next' },
  auth: { type: 'bearer' as const }, max_pages: 10,
});

function serveRetail() {
  const files = retailCsv();
  const data: Record<string, Array<Record<string, string>>> = {
    '/v1/products': rows(files.offerings), '/v1/stock': rows(files.inventory_items), '/v1/orders': rows(files.transactions), '/v1/order-lines': rows(files.transaction_lines),
    '/v1/customers': rows(files.customers), '/v1/resources': rows(files.resources), '/v1/shifts': rows(files.capacity_windows),
  };
  respond = (u) => {
    if (u.pathname === '/v1/health') return { status: 200, json: { ok: true } };
    const all = data[u.pathname];
    if (!all) return { status: 404 };
    // Two pages per entity (cursor pagination).
    const half = Math.ceil(all.length / 2);
    return u.searchParams.get('cursor') === 'p2' ? { status: 200, json: { data: all.slice(half), next: null } } : { status: 200, json: { data: all.slice(0, half), next: 'p2' } };
  };
}

async function restStore(name: string, base?: string) {
  const b = await loomBusinesses.createExternal(actor, { name, sector_pack: 'retail', timezone: 'Asia/Riyadh', currency: 'SAR', locale: 'en' });
  const created = await loomConnections.create(ctx(b.id), { kind: 'rest', name: 'Store API', config: restConfig(base), secret: SECRET });
  return { id: b.id, conn: created.connection.id, ingestSecret: created.ingest_secret!, created };
}

describe('REST pull connector', () => {
  it('pulls every page through the SSRF-safe fetcher with the server-side secret, then passes review and analysis', async () => {
    serveRetail();
    const s = await restStore('REST Store');
    await loomConnections.putMapping(ctx(s.id), s.conn, RETAIL_MAPPING);
    const health = await loomConnections.action(ctx(s.id), s.conn, 'test') as any;
    expect(health.health.status).toBe('ok');
    const sync = await loomConnections.action(ctx(s.id), s.conn, 'sync') as any;
    expect(sync.status).toBe('succeeded');
    expect(sync.entities.transactions.inserted).toBe(60);
    expect(seen.filter((r) => r.url.includes('/v1/orders')).map((r) => new URL(r.url).searchParams.get('cursor'))).toEqual([null, 'p2']);
    expect(seen.every((r) => r.headers.authorization === `Bearer ${SECRET}`)).toBe(true);
    expect(sync.review_status).toBe('pending_review');
    await loomConnections.review(ctx(s.id), s.conn, { decision: 'approve' });
    const out = await analyzeNow(s.id);
    expect(out!.status).toBe('succeeded');
    expect(out!.result).toMatchObject({ snapshot: { connector: 'rest' } });
  });

  it('blocks internal hosts and addresses (SSRF), records the failure and never fetches', async () => {
    serveRetail();
    await expect(loomConnections.create(ctx((await loomBusinesses.createExternal(actor, { name: 'Bad URL', sector_pack: 'retail', timezone: 'Asia/Riyadh', currency: 'SAR', locale: 'en' })).id),
      { kind: 'rest', name: 'x', config: restConfig('http://api.store.example') as any })).rejects.toThrow();
    const internal = await restStore('Internal', 'https://metadata.internal/v1');
    await loomConnections.putMapping(ctx(internal.id), internal.conn, RETAIL_MAPPING);
    const h = await loomConnections.action(ctx(internal.id), internal.conn, 'test') as any;
    expect(h.health).toMatchObject({ status: 'down', detail: 'blocked_address' });
    const sync = await loomConnections.action(ctx(internal.id), internal.conn, 'sync') as any;
    expect(sync).toMatchObject({ status: 'failed', error: 'http:blocked_address' });
    const rebind = await restStore('Rebind', 'https://rebind.store.example/v1');
    await loomConnections.putMapping(ctx(rebind.id), rebind.conn, RETAIL_MAPPING);
    expect(((await loomConnections.action(ctx(rebind.id), rebind.conn, 'sync')) as any).error).toBe('http:blocked_address');
    expect(seen).toEqual([]);
    const c = await loomConnections.get({ businessId: rebind.id, locale: 'en' }, rebind.conn);
    expect(c).toMatchObject({ status: 'error', last_error: 'http:blocked_address' });
  });

  it('secrets are stored encrypted and never returned', async () => {
    const s = await restStore('Secret Store');
    expect(s.ingestSecret).toMatch(/^whsec_/);
    const views = [s.created.connection, await loomConnections.get({ businessId: s.id, locale: 'en' }, s.conn), await loomConnections.list({ businessId: s.id })];
    for (const v of views) {
      const json = JSON.stringify(v);
      expect(json).not.toContain(SECRET);
      expect(json).not.toContain(s.ingestSecret);
      expect(json).not.toMatch(/secret_enc|v1\.[A-Za-z0-9_-]{8,}\./);
    }
    expect(s.created.connection).toMatchObject({ has_secret: true, has_ingest_secret: true });
    const row = await withTenant(s.id, (trx) => trx.selectFrom('loom.connections').select(['secret_enc', 'ingest_secret_enc']).where('id', '=', s.conn).executeTakeFirstOrThrow());
    expect(row.secret_enc).not.toContain(SECRET);
    expect(row.ingest_secret_enc).not.toContain(s.ingestSecret);
    // Rotation returns the new ingest secret once; audit data carries no secret.
    const rot = await loomConnections.update(ctx(s.id), s.conn, { rotate_ingest_secret: true, secret: 'sk_live_rotated_secret_456' });
    expect(rot.ingest_secret).not.toBe(s.ingestSecret);
    const audit = await withTenant(s.id, (trx) => trx.selectFrom('loom.audit_events').select('data').where('business_id', '=', s.id).execute());
    expect(JSON.stringify(audit)).not.toMatch(/sk_live|whsec_/);
  });
});

describe('Inbound webhook ingest (HMAC-SHA256, replay window, idempotent)', () => {
  const post = (conn: string, body: string, headers: Record<string, string>) =>
    ingest.POST(new NextRequest(`http://localhost:3000/api/v1/loom/ingest/${conn}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body }), { params: Promise.resolve({ connection: conn }) });

  it('accepts a valid signature once, refuses invalid / stale / unknown, applies upserts and tombstones', async () => {
    const s = await restStore('Webhook Store');
    await loomConnections.putMapping(ctx(s.id), s.conn, RETAIL_MAPPING);
    const body = JSON.stringify({ events: [
      { entity: 'offerings', data: { id: 'W1', kind: 'product', name: 'Webhook product', price: '12.50', cost: '4.00' } },
      { entity: 'offerings', data: { id: 'W2', kind: 'product', name: 'Second', price: '9.00' } },
      { entity: 'transactions', data: { order_no: 'T-9', state: 'done', occurred_at: '2026-11-01 10:00', total: '12.50' } },
    ] });
    const now = Math.floor(Date.now() / 1000);
    const sig = signBody(s.ingestSecret, body, now);
    const ok = await post(s.conn, body, { 'x-loom-signature': sig, 'x-loom-event-id': 'evt-1' });
    expect(ok.status).toBe(202);
    expect((await ok.json()).data).toMatchObject({ duplicate: false, result: { offerings: { inserted: 2 }, transactions: { inserted: 1 } } });
    const dup = await post(s.conn, body, { 'x-loom-signature': sig, 'x-loom-event-id': 'evt-1' });
    expect(dup.status).toBe(200);
    expect((await dup.json()).data.duplicate).toBe(true);
    const bad = await post(s.conn, body, { 'x-loom-signature': signBody('whsec_wrong', body, now), 'x-loom-event-id': 'evt-2' });
    expect([bad.status, (await bad.json()).error.code]).toEqual([401, 'bad_signature']);
    const tampered = await post(s.conn, body.replace('12.50', '1.00'), { 'x-loom-signature': sig, 'x-loom-event-id': 'evt-3' });
    expect(tampered.status).toBe(401);
    const stale = await post(s.conn, body, { 'x-loom-signature': signBody(s.ingestSecret, body, now - 3600), 'x-loom-event-id': 'evt-4' });
    expect([stale.status, (await stale.json()).error.code]).toEqual([401, 'stale_timestamp']);
    expect((await post(s.conn, body, { 'x-loom-event-id': 'evt-5' })).status).toBe(401);
    expect((await post('00000000-0000-4000-8000-000000000000', body, { 'x-loom-signature': sig, 'x-loom-event-id': 'evt-6' })).status).toBe(404);
    expect((await post('nope', body, { 'x-loom-signature': sig, 'x-loom-event-id': 'evt-6' })).status).toBe(404);
    // Delete → tombstone (kept for history, out of the dataset).
    const del = JSON.stringify({ events: [{ entity: 'offerings', op: 'delete', data: { id: 'W2' } }] });
    expect((await post(s.conn, del, { 'x-loom-signature': signBody(s.ingestSecret, del, now), 'x-loom-event-id': 'evt-7' })).status).toBe(202);
    const ds = await loadDataset(connectorFor('rest'), { id: s.conn, business_id: s.id, kind: 'rest', config: {} });
    expect(ds.offerings.map((o) => o.id)).toEqual(['W1']);
    expect(ds.transactions[0]).toMatchObject({ id: 'T-9', status: 'fulfilled', net_minor: 1250 });
    const events = await withTenant(s.id, (trx) => trx.selectFrom('loom.ingest_events').select('event_id').where('connection_id', '=', s.conn).orderBy('event_id').execute());
    expect(events.map((e) => e.event_id)).toEqual(['evt-1', 'evt-7']);
    // Paused connections refuse events.
    await loomConnections.action(ctx(s.id), s.conn, 'pause');
    const p = JSON.stringify({ events: [{ entity: 'offerings', data: { id: 'W3', kind: 'product', name: 'P', price: '1' } }] });
    expect((await post(s.conn, p, { 'x-loom-signature': signBody(s.ingestSecret, p, now), 'x-loom-event-id': 'evt-8' })).status).toBe(409);
  });
});

describe('Outgoing webhooks', () => {
  it('signs deliveries, retries with backoff through the jobs framework and keeps a delivery log', async () => {
    const s = await restStore('Hooks Store');
    const { endpoint, signing_secret } = await loomWebhooks.createEndpoint(ctx(s.id), { url: 'https://hooks.partner.example/loom', events: ['plan.ready', 'outcome.measured'] });
    expect(JSON.stringify(await loomWebhooks.listEndpoints({ businessId: s.id }))).not.toContain(signing_secret);
    const n = await withTenant(s.id, (trx) => emitLoomEvent(trx, s.id, 'plan.ready', 'plan-1:v1', { plan_id: 'plan-1', version: 1 }));
    expect(n).toBe(1);
    // Not subscribed ⇒ no delivery; same event again ⇒ idempotent.
    expect(await withTenant(s.id, (trx) => emitLoomEvent(trx, s.id, 'opportunity.created', 'x', {}))).toBe(0);
    expect(await withTenant(s.id, (trx) => emitLoomEvent(trx, s.id, 'plan.ready', 'plan-1:v1', {}))).toBe(0);
    const d = await withTenant(s.id, (trx) => trx.selectFrom('loom.webhook_deliveries').selectAll().where('endpoint_id', '=', endpoint.id).executeTakeFirstOrThrow());
    const job = await withSystem('test', (trx) => trx.selectFrom('job_runs').selectAll().where('kind', '=', 'loom.webhook_delivery').where('dedupe_key', '=', `loom_webhook:${d.id}`).executeTakeFirstOrThrow());
    expect(job).toMatchObject({ tenant_id: null, max_attempts: 6, status: 'queued' });
    expect(job.payload).toMatchObject({ delivery_id: d.id, business_id: s.id });

    // Attempt 1 fails (HTTP 500) through the runner: re-queued with backoff, logged.
    respond = () => ({ status: 500, json: { error: 'down' } });
    await withSystem('test: only this job', (trx) => trx.updateTable('job_runs').set({ status: 'cancelled' }).where('status', '=', 'queued').where('id', '!=', job.id).execute());
    await runDueJobs(5);
    const after1 = await withSystem('test', (trx) => trx.selectFrom('job_runs').select(['status', 'attempts', 'run_at', 'last_error']).where('id', '=', job.id).executeTakeFirstOrThrow());
    expect(after1).toMatchObject({ status: 'queued', attempts: 1 });
    expect(after1.run_at.getTime()).toBeGreaterThan(Date.now() + 10_000);
    const log1 = await withTenant(s.id, (trx) => trx.selectFrom('loom.webhook_deliveries').selectAll().where('id', '=', d.id).executeTakeFirstOrThrow());
    expect(log1).toMatchObject({ status: 'pending', attempts: 1, last_status: 500 });

    // Attempt 2 succeeds: the receiver verifies the signature with its secret.
    respond = () => ({ status: 200, json: { ok: true } });
    await withSystem('test: due now', (trx) => trx.updateTable('job_runs').set({ run_at: new Date() }).where('id', '=', job.id).execute());
    await runDueJobs(5);
    const req = seen.at(-1)!;
    expect(req.method).toBe('POST');
    expect(req.headers['x-loom-event-id']).toBe(d.event_id);
    expect(() => verifySignature(signing_secret, req.body!, req.headers['x-loom-signature']!)).not.toThrow();
    expect(() => verifySignature('whsec_other', req.body!, req.headers['x-loom-signature']!)).toThrow();
    expect(JSON.parse(req.body!)).toMatchObject({ type: 'plan.ready', business_id: s.id, data: { plan_id: 'plan-1' } });
    const log2 = await withTenant(s.id, (trx) => trx.selectFrom('loom.webhook_deliveries').selectAll().where('id', '=', d.id).executeTakeFirstOrThrow());
    expect(log2).toMatchObject({ status: 'delivered', attempts: 2, last_status: 200 });

    // The last attempt marks the delivery failed; blocked destinations are failures too.
    await withTenant(s.id, (trx) => emitLoomEvent(trx, s.id, 'outcome.measured', 'init-9', { initiative_id: 'init-9' }));
    const d2 = await withTenant(s.id, (trx) => trx.selectFrom('loom.webhook_deliveries').select('id').where('event_type', '=', 'outcome.measured').executeTakeFirstOrThrow());
    respond = () => ({ status: 503 });
    await expect(deliverWebhook(s.id, d2.id, 6)).rejects.toThrow(/webhook delivery failed/);
    expect((await withTenant(s.id, (trx) => trx.selectFrom('loom.webhook_deliveries').select(['status', 'attempts']).where('id', '=', d2.id).executeTakeFirstOrThrow()))).toEqual({ status: 'failed', attempts: 1 });
  });

  it('LUMA tenant: opportunity.created after an analysis; approving never sends a campaign; webhooks are tenant-isolated', async () => {
    const s = await loomSalon({ consents: true });
    const other = await loomSalon({ name: 'Other Owner' });
    const created = await s.owner.call(hooks.POST, { params: s.p, body: { url: 'https://crm.partner.example/hooks', events: ['opportunity.created', 'plan.ready'] } });
    expect(created.status).toBe(201);
    const secret = created.body.data.signing_secret;
    const listed = await s.owner.call(hooks.GET, { params: s.p });
    expect(JSON.stringify(listed.body)).not.toContain(secret);
    expect((await other.owner.call(hooks.GET, { params: other.p })).body.data.endpoints).toEqual([]);
    await analyzeNow(s.biz.tenantId);
    const deliveries = await withTenant(s.biz.tenantId, (trx) => trx.selectFrom('loom.webhook_deliveries').select(['event_type', 'payload']).where('business_id', '=', s.biz.tenantId).execute());
    const cards = (await s.owner.call(opps.GET, { params: s.p })).body.data as any[];
    expect(deliveries.length).toBe(cards.length);
    expect(deliveries.every((d) => d.event_type === 'opportunity.created')).toBe(true);
    const jobs = await withSystem('test', (trx) => trx.selectFrom('job_runs').select(['tenant_id']).where('kind', '=', 'loom.webhook_delivery').where('tenant_id', '=', s.biz.tenantId).execute());
    expect(jobs.length).toBe(deliveries.length);
    // Re-analysis: no new event for the same opportunities.
    await analyzeNow(s.biz.tenantId);
    expect((await withTenant(s.biz.tenantId, (trx) => trx.selectFrom('loom.webhook_deliveries').select('id').execute())).length).toBe(deliveries.length);
    // Approving an opportunity creates no campaign.
    await s.owner.call(decision.POST, { params: { ...s.p, id: cards[0].card.opportunity_id }, body: { action: 'approve' } });
    const campaigns = await withTenant(s.biz.tenantId, (trx) => trx.selectFrom('campaigns').select('id').execute());
    expect(campaigns).toEqual([]);
    // Other tenants see none of it.
    expect((await withTenant(other.biz.tenantId, (trx) => trx.selectFrom('loom.webhook_deliveries').select('id').execute()))).toEqual([]);
  });

  it('LUMA tenant routes: connection lifecycle needs business.manage; sector pack limited to enabled packs; vocabulary follows the pack', async () => {
    const s = await loomSalon();
    const c = await s.owner.call(conns.POST, { params: s.p, body: { kind: 'csv_import', name: 'Old POS' } });
    expect(c.status).toBe(201);
    expect(c.body.data.connection).toMatchObject({ kind: 'csv_import', review_status: 'pending_mapping', primary_source: false });
    const list = (await s.owner.call(conns.GET, { params: s.p })).body.data as any[];
    expect(list.map((x) => x.kind).sort()).toEqual(['csv_import']);
    await analyzeNow(s.biz.tenantId);
    expect(((await s.owner.call(conns.GET, { params: s.p })).body.data as any[]).map((x) => x.kind).sort()).toEqual(['csv_import', 'luma']);
    // The unapproved CSV connection does not replace LUMA as the analysis source.
    expect((await s.owner.call(connOne.POST, { params: { ...s.p, id: c.body.data.connection.id }, body: { action: 'pause' } })).body.data).toEqual({ status: 'paused' });
    const pack = await s.owner.call(packRoute.GET, { params: s.p });
    expect(pack.body.data).toMatchObject({ current: 'beauty', explicit: false });
    expect(pack.body.data.packs.find((p: any) => p.id === 'restaurant').enabled).toBe(false);
    expect((await s.owner.call(packRoute.PUT, { method: 'PUT', params: s.p, body: { sector_pack: 'restaurant' } })).status).toBe(422);
    const set = await s.owner.call(packRoute.PUT, { method: 'PUT', params: s.p, body: { sector_pack: 'retail' } });
    expect(set.body.data).toMatchObject({ current: 'retail', explicit: true });
    expect(set.body.data.vocabulary.offering).toBeTruthy();
    // Owner-level capability: a manager without business.manage cannot reach connections.
    const { addMember } = await import('../helpers/platform');
    const mgr = await addMember(s.owner, s.biz.slug, 'manager');
    expect((await mgr.call(conns.GET, { params: s.p })).status).toBe(403);
  });
});
