import { afterAll, describe, expect, it } from 'vitest';
import { closeDb } from '@/server/db/client';
import { resetRoleCheck } from '@/server/db/role-guard';
import { resetEnvCache } from '@/server/env';
import * as health from '@/app/api/v1/health/route';
import * as session from '@/app/api/v1/auth/session/route';
import { TestClient } from '../helpers/http';

const appUrl = process.env.DATABASE_URL!;
const ownerUrl = process.env.TEST_DATABASE_OWNER_URL ?? 'postgres://luma_owner:luma_owner_dev@localhost:5432/luma_test';

async function connectAs(url: string, appEnv: string) {
  await closeDb();
  process.env.DATABASE_URL = url;
  process.env.APP_ENV = appEnv;
  resetEnvCache(); resetRoleCheck();
}

describe('runtime database role guard', () => {
  afterAll(async () => { await connectAs(appUrl, 'test'); });

  it('the application role keeps RLS enforced', async () => {
    await connectAs(appUrl, 'review');
    expect(await (await health.GET()).json()).toEqual({ ok: true, db: 'up', rls: 'enforced' });
  });

  it('a deployed build connected as the table owner refuses to serve', async () => {
    await connectAs(ownerUrl, 'review');
    const h = await health.GET();
    expect(h.status).toBe(503);
    expect(await h.json()).toMatchObject({ ok: false, rls: 'bypassed' });
    const r = await new TestClient().call(session.GET);
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe('unsafe_database_role');
  });
});
