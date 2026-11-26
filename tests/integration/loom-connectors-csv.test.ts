import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSystem, withTenant } from '@/server/db/client';
import '@/server/loom-host/runtime';
import { analyzeNow, connectorFor, loadDataset, loomApi, loomBusinesses, loomConnections, type Transaction } from '@/loom';
import { enableRetailPack, RETAIL_MAPPING, retailCsv } from '../helpers/loom-retail';

/**
 * Phase 7: a business OUTSIDE LUMA (no tenant tables) imports its data as CSV,
 * maps it, passes the quality gate and a human review, and gets explained
 * opportunities from the retail pack.
 */
const actor = { userId: null, kind: 'platform' as const };
const ctx = (businessId: string) => ({ businessId, actor, locale: 'en' as const });

beforeAll(async () => {
  await enableRetailPack();
});
afterAll(async () => {
  await withSystem('test: reset loom settings', (trx) => trx.deleteFrom('loom.loom_settings').execute());
  await withSystem('test cleanup', (trx) => trx.updateTable('job_runs').set({ status: 'cancelled' }).where('status', '=', 'queued').where('kind', 'like', 'loom.%').execute());
});

async function externalStore(name = 'Brew Supply') {
  const b = await loomBusinesses.createExternal(actor, { name, sector_pack: 'retail', timezone: 'Asia/Riyadh', currency: 'SAR', locale: 'en' });
  const { connection } = await loomConnections.create(ctx(b.id), { kind: 'csv_import', name: 'POS export' });
  return { id: b.id, conn: connection.id };
}

async function uploadAll(s: { id: string; conn: string }, files = retailCsv()) {
  const out: Record<string, any> = {};
  for (const [entity, content] of Object.entries(files)) out[entity] = await loomConnections.upload(ctx(s.id), s.conn, { entity: entity as any, filename: `${entity}.csv`, content });
  return out;
}

describe('CSV import: templates, validation and the mapping step', () => {
  it('validates the header and values against the template; refuses contact columns; flags unmapped statuses', async () => {
    const s = await externalStore('Validation Store');
    const missing = await loomConnections.upload(ctx(s.id), s.conn, { entity: 'offerings', filename: 'o.csv', content: 'id,kind,price\nP1,product,10\n' });
    expect(missing.status).toBe('invalid');
    expect(missing.errors).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'name', code: 'missing_column' })]));
    const badType = await loomConnections.upload(ctx(s.id), s.conn, { entity: 'offerings', filename: 'o.csv', content: 'id,kind,name,price\nP1,widget,X,ten\n' });
    expect(badType.errors.map((e: any) => `${e.field}:${e.code}`)).toEqual(expect.arrayContaining(['kind:invalid_value', 'price:invalid_value']));
    const pii = await loomConnections.upload(ctx(s.id), s.conn, { entity: 'customers', filename: 'c.csv', content: 'pseudo_id,phone,email\nC1,+966500000000,a@b.c\n' });
    expect(pii.status).toBe('invalid');
    expect(pii.errors.filter((e: any) => e.code === 'pii_column').map((e: any) => e.field).sort()).toEqual(['email', 'phone']);
    // Before the mapping step, source column names and statuses are unknown.
    const tx = await loomConnections.upload(ctx(s.id), s.conn, { entity: 'transactions', filename: 't.csv', content: retailCsv().transactions });
    expect(tx.status).toBe('invalid');
    expect(tx.errors.map((e: any) => e.field)).toEqual(expect.arrayContaining(['id', 'status']));
    // The mapping renames columns and maps the source's own statuses.
    await loomConnections.putMapping(ctx(s.id), s.conn, RETAIL_MAPPING);
    const tx2 = await loomConnections.upload(ctx(s.id), s.conn, { entity: 'transactions', filename: 't.csv', content: retailCsv().transactions });
    expect(tx2).toMatchObject({ status: 'valid', error_count: 0, unmapped_statuses: [] });
    const odd = await loomConnections.upload(ctx(s.id), s.conn, { entity: 'transactions', filename: 't.csv', content: 'order_no,state,occurred_at,total\nX1,on_hold,2026-01-01 10:00,10\n' });
    expect(odd.unmapped_statuses).toEqual(['on_hold']);
    // Invalid content is not kept.
    const files = await withTenant(s.id, (trx) => trx.selectFrom('loom.import_files').select(['status', 'content']).where('status', '=', 'invalid').execute());
    expect(files.every((f) => f.content === '')).toBe(true);
  });

  it('statuses are normalised, the revenue basis is applied, and the dataset never touches LUMA tables', async () => {
    const s = await externalStore('Basis Store');
    await loomConnections.putMapping(ctx(s.id), s.conn, RETAIL_MAPPING);
    await uploadAll(s);
    const sync = await loomConnections.action(ctx(s.id), s.conn, 'sync') as any;
    expect(sync.status).toBe('succeeded');
    const ds = await loadDataset(connectorFor('csv_import'), { id: s.conn, business_id: s.id, kind: 'csv_import', config: {} });
    const byId = new Map(ds.transactions.map((t: Transaction) => [t.id, t]));
    const done = byId.get('O-1000')!, refunded = byId.get('O-1007')!, voided = byId.get('O-1011')!;
    expect([done.status, done.source_status]).toEqual(['fulfilled', 'done']);
    expect(refunded.status).toBe('cancelled_customer');
    expect(voided.status).toBe('cancelled_business');
    // total 325.00 incl. 15% VAT (after discount, before tax, after refunds); lines share it pro rata.
    expect(done.total_minor).toBe(32500);
    expect(done.net_minor).toBe(done.total_minor - done.tax_minor);
    expect(done.lines.reduce((m, l) => m + l.net_minor, 0)).toBe(done.net_minor);
    expect(refunded.net_minor).toBe(0);
    expect(done.consistent).toBe(true);
    expect(ds.business).toMatchObject({ id: s.id, sector: 'retail', currency: 'SAR', timezone: 'Asia/Riyadh' });
    // Derived: inventory sales from transactions; customers' visits.
    expect(ds.inventory.find((i) => i.id === 'I1')!.sold_90d).toBeGreaterThan(40);
    expect(ds.customers.find((c) => c.pseudo_id === 'C1')!.visits).toBeGreaterThan(0);
    // Material cost from the recorded unit cost (complete).
    expect(ds.costs.find((c) => c.type === 'material' && c.scope.kind === 'offering' && c.scope.offering_id === 'P1')).toMatchObject({ amount_minor: 3000, completeness: 'complete' });
  });

  it('dedupes by (connection, entity, source id), tombstones deletions and links suspected duplicates without merging', async () => {
    const s = await externalStore('Dedupe Store');
    await loomConnections.putMapping(ctx(s.id), s.conn, RETAIL_MAPPING);
    await uploadAll(s);
    const first = await loomConnections.action(ctx(s.id), s.conn, 'sync') as any;
    expect(first.entities.offerings).toMatchObject({ inserted: 6, updated: 0, tombstoned: 0 });
    // Same files again: nothing re-applied (cursor = file version) …
    const again = await loomConnections.action(ctx(s.id), s.conn, 'sync') as any;
    expect(again.entities).toEqual({});
    // … a new version of offerings without P4 and with P2 repriced: one update, one tombstone, the rest unchanged.
    const lines = retailCsv().offerings.trim().split('\n');
    const v2 = [lines[0], ...lines.slice(1).filter((l) => !l.startsWith('P4,')).map((l) => (l.startsWith('P2,') ? l.replace(',15.00,', ',17.00,') : l))].join('\n');
    await loomConnections.upload(ctx(s.id), s.conn, { entity: 'offerings', filename: 'offerings-v2.csv', content: v2 });
    const second = await loomConnections.action(ctx(s.id), s.conn, 'sync') as any;
    expect(second.entities.offerings).toMatchObject({ inserted: 0, updated: 1, unchanged: 4, tombstoned: 1, file_version: 2 });
    const rows = await withTenant(s.id, (trx) => trx.selectFrom('loom.canonical_records').select(['source_id', 'deleted_at']).where('connection_id', '=', s.conn).where('entity', '=', 'offerings').execute());
    expect(rows).toHaveLength(6);
    expect(rows.find((r) => r.source_id === 'P4')!.deleted_at).not.toBeNull();
    const ds = await loadDataset(connectorFor('csv_import'), { id: s.conn, business_id: s.id, kind: 'csv_import', config: {} });
    expect(ds.offerings.map((o) => o.id).sort()).toEqual(['P1', 'P2', 'P3', 'P5', 'P6']);
    expect(ds.offerings.find((o) => o.id === 'P2')!.price_minor).toBe(1700);
    // Suspected duplicates: same contact hash (customers), same name (offerings); never merged.
    const detail = await loomConnections.get({ businessId: s.id, locale: 'en' }, s.conn);
    expect(detail.links).toEqual(expect.arrayContaining([
      expect.objectContaining({ entity: 'customers', source_id_a: 'C29', source_id_b: 'C30', reason: 'same_contact_hash', status: 'suggested' }),
      expect.objectContaining({ entity: 'offerings', source_id_a: 'P1', source_id_b: 'P6', reason: 'same_name', confidence: 0.5 }),
    ]));
    expect(ds.customers.filter((c) => c.pseudo_id === 'C29' || c.pseudo_id === 'C30')).toHaveLength(2);
    const linkId = detail.links.find((l: any) => l.entity === 'customers')!.id;
    expect(await loomConnections.decideLink(ctx(s.id), s.conn, { link_id: linkId, status: 'rejected' })).toEqual({ id: linkId, status: 'rejected' });
  });
});

describe('First-snapshot review gate (§16) and an external business end to end', () => {
  it('analyses refuse the connection until mapping + quality + human confirmation; then the retail pack produces opportunities', async () => {
    const s = await externalStore('Gate Store');
    // No approved connection: the analysis fails closed.
    expect(await analyzeNow(s.id)).toBeNull();
    expect((await loomApi.listAnalyses({ businessId: s.id, locale: 'en' }))[0]).toMatchObject({ status: 'failed', error_code: 'connection_review_required' });
    // Sync without a mapping is refused; approval before review is refused.
    await expect(loomConnections.action(ctx(s.id), s.conn, 'sync')).rejects.toMatchObject({ code: 'mapping_required' });
    await expect(loomConnections.review(ctx(s.id), s.conn, { decision: 'approve' })).rejects.toMatchObject({ code: 'review_not_ready' });
    await loomConnections.putMapping(ctx(s.id), s.conn, RETAIL_MAPPING);
    await uploadAll(s);
    const sync = await loomConnections.action(ctx(s.id), s.conn, 'sync') as any;
    expect(sync.review).toMatchObject({ ready: true, blockers: [], quality: { overall: expect.stringMatching(/ok|limited/) } });
    expect(sync.review_status).toBe('pending_review');
    expect(sync.review.counts.transactions).toBe(60);
    // Still not approved ⇒ still refused.
    expect(await analyzeNow(s.id)).toBeNull();
    const ok = await loomConnections.review(ctx(s.id), s.conn, { decision: 'approve', note: 'first snapshot checked' });
    expect(ok).toEqual({ review_status: 'approved', primary_source: true });

    const out = await analyzeNow(s.id);
    expect(out!.status).toBe('succeeded');
    expect(out!.result).toMatchObject({ sector_pack: 'retail-1.0.0', snapshot: { connector: 'csv_import' } });
    const opps = await loomApi.listOpportunities({ businessId: s.id, locale: 'en' }, { open: '1' } as any);
    const detectors = opps.map((o: any) => o.detector_id);
    expect(detectors).toEqual(expect.arrayContaining(['stockout_risk', 'retail_slow_mover_bundle', 'basket_cross_sell']));
    const stock = opps.find((o: any) => o.detector_id === 'stockout_risk')!;
    expect(stock.card.category).toBe('stockout_risk');
    expect(stock.card.recommended_action.kind).toBe('restock');
    const basket = opps.find((o: any) => o.detector_id === 'basket_cross_sell')!;
    expect(basket.card.title).toBe('Hand grinder with Travel mug');
    const row = await withTenant(s.id, (trx) => trx.selectFrom('loom.opportunities').select(['sector_pack', 'sector_pack_version']).where('business_id', '=', s.id).executeTakeFirstOrThrow());
    expect(row).toEqual({ sector_pack: 'retail', sector_pack_version: 'retail-1.0.0' });
    // Every card cites stored evidence.
    const one = await loomApi.getOpportunity({ businessId: s.id, locale: 'en' }, stock.card.opportunity_id);
    expect(one.evidence.length).toBeGreaterThan(0);

    // Changing the mapping sends the connection back to review: analyses refuse it again.
    await loomConnections.putMapping(ctx(s.id), s.conn, { ...RETAIL_MAPPING, revenue_basis: { ...RETAIL_MAPPING.revenue_basis, subtract_refunds: false } });
    expect(await analyzeNow(s.id)).toBeNull();
    // No LUMA tenant exists for it; its audit trail is Loom's own.
    const tenant = await withSystem('test', (trx) => trx.selectFrom('tenants').select('id').where('id', '=', s.id).executeTakeFirst());
    expect(tenant).toBeUndefined();
    const audit = await withTenant(s.id, (trx) => trx.selectFrom('loom.audit_events').select('action').where('business_id', '=', s.id).execute());
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['loom.external_business_created', 'loom.connection_created', 'loom.mapping_updated', 'loom.connection_approved']));
  });

  it('a sector pack must be enabled by the platform; businesses are isolated from each other', async () => {
    await expect(loomBusinesses.createExternal(actor, { name: 'Diner', sector_pack: 'restaurant', timezone: 'Asia/Riyadh', currency: 'SAR', locale: 'ar' })).rejects.toMatchObject({ code: 'sector_pack_disabled' });
    await expect(loomBusinesses.createExternal(actor, { name: 'Nope', sector_pack: 'nope', timezone: 'Asia/Riyadh', currency: 'SAR', locale: 'ar' })).rejects.toMatchObject({ code: 'unknown_sector_pack' });
    const a = await externalStore('Iso A');
    const b = await externalStore('Iso B');
    await loomConnections.putMapping(ctx(a.id), a.conn, RETAIL_MAPPING);
    await uploadAll(a);
    await loomConnections.action(ctx(a.id), a.conn, 'sync');
    // B cannot see A's connection, records or files.
    await expect(loomConnections.get({ businessId: b.id, locale: 'en' }, a.conn)).rejects.toMatchObject({ status: 404 });
    const seen = await withTenant(b.id, (trx) => trx.selectFrom('loom.canonical_records').select('id').where('connection_id', '=', a.conn).execute());
    expect(seen).toEqual([]);
    // Writing a row for another business is refused by RLS.
    await expect(withTenant(b.id, (trx) => trx.insertInto('loom.canonical_records').values({ business_id: a.id, connection_id: a.conn, entity: 'offerings', source_id: 'X', source_version: '1', data: '{}' }).execute())).rejects.toThrow();
    // resolveExternal never resolves a LUMA tenant or garbage.
    await expect(loomBusinesses.resolveExternal('not-a-uuid')).rejects.toMatchObject({ status: 404 });
  });
});
