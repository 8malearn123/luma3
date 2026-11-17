import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSystem } from '@/server/db/client';
import '@/server/loom-host/runtime';
import { analyzeNow, loomApi, loomBusinesses, loomConnections } from '@/loom';
import { enableRetailPack, RETAIL_MAPPING, retailCsv } from '../helpers/loom-retail';

/**
 * Extraction readiness (docs/LOOM_EXTRACTION.md): Loom's pipeline and its
 * generic connectors must run with NO access to LUMA's schema. The test
 * revokes the runtime role's USAGE on schema public for the duration of an
 * end-to-end run (CSV sync → review → approval → analysis → opportunities)
 * of an external business: any read or write of a LUMA table would fail
 * (the relation is no longer resolvable).
 */
const actor = { userId: null, kind: 'platform' as const };
const OWNER_URL = process.env.TEST_DATABASE_OWNER_URL ?? 'postgres://luma_owner:luma_owner_dev@localhost:5432/luma_test';

async function owner(sqlText: string) {
  const c = new pg.Client({ connectionString: OWNER_URL });
  await c.connect();
  try { return await c.query(sqlText); } finally { await c.end(); }
}

beforeAll(async () => { await enableRetailPack(); });
afterAll(async () => {
  await owner('grant usage on schema public to public');
  await withSystem('test: reset loom settings', (trx) => trx.deleteFrom('loom.loom_settings').execute());
});

describe('Loom is host-agnostic', () => {
  it('runs the whole pipeline for an external business without touching any LUMA table', async () => {
    const b = await loomBusinesses.createExternal(actor, { name: 'Detached Store', sector_pack: 'retail', timezone: 'Asia/Riyadh', currency: 'SAR', locale: 'ar' });
    const c = { businessId: b.id, actor, locale: 'ar' as const };
    await owner('revoke usage on schema public from public');
    try {
      // Sanity: the runtime role really lost LUMA.
      await expect(withSystem('test', (trx) => trx.selectFrom('tenants').select('id').limit(1).execute())).rejects.toThrow(/permission denied|does not exist/);
      const { connection } = await loomConnections.create(c, { kind: 'csv_import', name: 'Export' });
      await loomConnections.putMapping(c, connection.id, RETAIL_MAPPING);
      for (const [entity, content] of Object.entries(retailCsv())) await loomConnections.upload(c, connection.id, { entity: entity as any, filename: `${entity}.csv`, content });
      const sync = await loomConnections.action(c, connection.id, 'sync') as any;
      expect(sync.review_status).toBe('pending_review');
      await loomConnections.review(c, connection.id, { decision: 'approve' });
      const out = await analyzeNow(b.id);
      expect(out!.status).toBe('succeeded');
      const opps = await loomApi.listOpportunities({ businessId: b.id, locale: 'ar' }, { open: '1' } as any);
      expect(opps.length).toBeGreaterThan(0);
      expect(opps.every((o: any) => typeof o.card.title === 'string' && o.card.title.length > 0)).toBe(true);
      expect((await loomApi.getDataQuality({ businessId: b.id, locale: 'ar' })).status).toBe('ok');
    } finally {
      await owner('grant usage on schema public to public');
    }
  });

  it('the generic connectors, ports and services contain no host-specific code', () => {
    const root = path.resolve(import.meta.dirname, '../../src/loom');
    const files = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = path.join(d, f); return statSync(p).isDirectory() ? files(p) : [p]; });
    for (const f of files(root)) {
      const t = readFileSync(f, 'utf8');
      // Outbound HTTP only through the runtime port; no direct network modules.
      // A global fetch call (method calls on a port such as radarFetcher().fetch(...) and interface members are fine).
      expect(t, f).not.toMatch(/from 'node:(https?|net|dns)'|(?:\bawait\s+|\breturn\s+|[=(,]\s*|globalThis\.)fetch\(/);
      if (/connectors\/generic|webhooks|business|runtime|hosts/.test(f)) expect(t, f).not.toMatch(/loom_export\.|['"]tenant_id['"]|tenant_id:/);
    }
  });
});
