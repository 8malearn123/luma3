import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, db, sql, withSystem, withTenant } from '@/server/db/client';
import { checkRuntimeRole, resetRoleCheck } from '@/server/db/role-guard';
import { resetEnvCache } from '@/server/env';
import { createPglite, usePglite } from '@/server/db/pglite';

const saved = { DB_DRIVER: process.env.DB_DRIVER, DATABASE_URL: process.env.DATABASE_URL };
const g = globalThis as unknown as { __lumaPglite?: unknown };

describe('embedded database (DB_DRIVER=pglite)', () => {
  beforeAll(async () => {
    await closeDb();
    process.env.DB_DRIVER = 'pglite';
    process.env.DATABASE_URL = 'pglite://embedded';
    resetEnvCache(); resetRoleCheck();
    // A fresh, empty instance (not the deploy snapshot): migrated on first use.
    const fresh = await createPglite();
    await fresh.exec('create role luma_app');
    const { migrate } = await import('@/server/db/migrator');
    const { pgliteSqlClient } = await import('@/server/db/pglite');
    await migrate({ client: pgliteSqlClient(fresh), appRole: 'luma_app' });
    await fresh.exec('set role luma_app');
    usePglite(fresh);
  }, 120_000);

  afterAll(async () => {
    await closeDb();
    g.__lumaPglite = undefined;
    process.env.DB_DRIVER = saved.DB_DRIVER ?? '';
    process.env.DATABASE_URL = saved.DATABASE_URL;
    if (!saved.DB_DRIVER) delete process.env.DB_DRIVER;
    resetEnvCache(); resetRoleCheck();
  });

  it('runs every migration and connects as the non-owner role, so RLS applies', async () => {
    expect(await checkRuntimeRole()).toMatchObject({ role: 'luma_app', safe: true });
    expect((await sql<{ n: number }>`select count(*) as n from plans`.execute(db())).rows[0]!.n).toBe(3);
  });

  it('keeps tenant rows invisible outside their scope', async () => {
    const id = await withSystem('test: create tenant', async (trx) => {
      const u = await trx.insertInto('users').values({ email: 'embedded@example.test', display_name: 'Embedded', password_hash: 'x' }).returning('id').executeTakeFirstOrThrow();
      const t = await trx.insertInto('tenants').values({ slug: 'embedded-test', name: 'Embedded', business_type: 'salon', created_by: u.id }).returning('id').executeTakeFirstOrThrow();
      return t.id;
    });
    expect((await db().selectFrom('tenants').select('id').execute()).length).toBe(0);
    expect(await withTenant(id, (trx) => trx.selectFrom('tenants').select('id').execute())).toHaveLength(1);
  });

  it('nested scopes reuse the single connection and restore the outer scope (no deadlock)', async () => {
    const r = await withTenant('00000000-0000-4000-8000-000000000001', async (trx) => {
      const inner = await withSystem('nested', async () => (await sql<{ s: string }>`select current_setting('app.scope', true) as s`.execute(db())).rows[0]!.s);
      const after = (await sql<{ s: string }>`select current_setting('app.scope', true) as s`.execute(trx)).rows[0]!.s;
      return { inner, after };
    });
    expect(r).toEqual({ inner: 'system', after: 'tenant' });
  });
});
