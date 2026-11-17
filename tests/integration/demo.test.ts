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

  it('is absent on every deployed build; DEMO_MODE there refuses to start instead of enabling it (R3)', async () => {
    process.env.PAYMENT_SANDBOX_WEBHOOK_SECRET = 'test-webhook-secret-long-enough-0123';
    for (const appEnv of ['review', 'production']) {
      process.env.APP_ENV = appEnv; process.env.DEMO_MODE = 'true'; process.env.DEV_OTP_ECHO = 'false'; resetEnvCache();
      const c = new TestClient();
      const r = await c.call(users.GET);
      expect(r.status).toBe(500); // misconfiguration: the server refuses to serve
      process.env.DEMO_MODE = 'false'; resetEnvCache();
      expect((await c.call(users.GET)).status).toBe(404);
      expect((await c.call(signIn.POST, { body: { key: '00000000-0000-0000-0000-000000000000' } })).status).toBe(404);
    }
    process.env.DEV_OTP_ECHO = 'true'; process.env.PAYMENT_SANDBOX_WEBHOOK_SECRET = 'test-webhook-secret';
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
