import { afterEach, describe, expect, it } from 'vitest';
import { TestClient } from '../helpers/http';
import { resetEnvCache } from '@/server/env';
import * as users from '@/app/api/v1/demo/users/route';
import * as signIn from '@/app/api/v1/demo/sign-in/route';

describe('demo role switching', () => {
  afterEach(() => { process.env.APP_ENV = 'test'; process.env.DEMO_MODE = 'false'; resetEnvCache(); });

  it('is absent when DEMO_MODE is off', async () => {
    const c = new TestClient();
    expect((await c.call(users.GET)).status).toBe(404);
  });

  it('is absent in production even if DEMO_MODE is on', async () => {
    process.env.APP_ENV = 'production'; process.env.DEMO_MODE = 'true'; resetEnvCache();
    const c = new TestClient();
    expect((await c.call(users.GET)).status).toBe(404);
    expect((await c.call(signIn.POST, { body: { key: '00000000-0000-0000-0000-000000000000' } })).status).toBe(404);
  });

  it('never signs into a non-demo account', async () => {
    process.env.DEMO_MODE = 'true'; resetEnvCache();
    const { signup } = await import('../helpers/factory');
    const real = await signup('Real');
    const s = await real.call((await import('@/app/api/v1/auth/session/route')).GET);
    const c = new TestClient();
    expect((await c.call(signIn.POST, { body: { key: s.body.data.user.id } })).status).toBe(404);
  });
});
