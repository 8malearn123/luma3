import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { TestClient } from '../helpers/http';
import { signup } from '../helpers/factory';
import { newSession, platformUser, userIdOf } from '../helpers/platform';
import { db } from '@/server/db/client';
import { resetEnvCache } from '@/server/env';
import { totpCode } from '@/server/domains/platform/totp';
import { DEMO_MFA_CODE, demoMfa } from '@/server/domains/platform/mfa';
import * as register from '@/app/api/v1/auth/register/route';
import * as recoveryRequest from '@/app/api/v1/auth/recovery/request/route';
import * as verifyRequest from '@/app/api/v1/auth/verify/request/route';
import * as devOutbox from '@/app/api/v1/auth/dev-outbox/route';
import * as login from '@/app/api/v1/auth/login/route';
import * as session from '@/app/api/v1/auth/session/route';
import * as demoUsers from '@/app/api/v1/demo/users/route';
import * as mfaSend from '@/app/api/v1/platform/mfa/send/route';
import * as mfaVerify from '@/app/api/v1/platform/mfa/verify/route';
import * as mfaEnroll from '@/app/api/v1/platform/mfa/enroll/route';
import * as mfaActivate from '@/app/api/v1/platform/mfa/activate/route';
import * as overview from '@/app/api/v1/platform/overview/route';

/**
 * LUMA-AUDIT-001 + R3: a deployed review build (APP_ENV=review, no messaging
 * provider) never discloses a one-time code anywhere; registration, recovery
 * and WhatsApp MFA are honestly unavailable; demo accounts sign in with their
 * password; TOTP is the working second factor; the fixed demo code is refused.
 */
const PASSWORD = 'correct horse battery';
const review = () => {
  process.env.APP_ENV = 'review';
  process.env.DEV_OTP_ECHO = 'false';
  process.env.DEMO_MODE = 'false';
  process.env.PAYMENT_SANDBOX_WEBHOOK_SECRET = 'review-sandbox-secret-0123456789';
  resetEnvCache();
};
const local = () => {
  process.env.APP_ENV = 'test';
  process.env.DEV_OTP_ECHO = 'true';
  process.env.DEMO_MODE = 'false';
  process.env.PAYMENT_SANDBOX_WEBHOOK_SECRET = 'test-webhook-secret';
  delete process.env.DB_DRIVER;
  resetEnvCache();
};

describe('deployed review build: no code exposure, password-only demo accounts (R3)', () => {
  let member: Awaited<ReturnType<typeof signup>>;
  let admin: Awaited<ReturnType<typeof platformUser>>;
  let adminPhone: string;

  beforeAll(async () => {
    // Accounts are created locally (as the seed does), then the build "deploys".
    member = await signup('Seeded member');
    admin = await platformUser('platform_owner', 'Seeded admin');
    adminPhone = `+9665${String(Date.now()).slice(-8)}`;
    await db().updateTable('users').set({ phone: adminPhone }).where('id', '=', await userIdOf(admin.identifier)).execute();
    review();
  });
  afterEach(() => review());
  afterAll(() => local());

  it('recovery: same response for known and unknown accounts, no code, honest "unavailable"', async () => {
    const c = new TestClient();
    const known = await c.call(recoveryRequest.POST, { body: { identifier: member.identifier } });
    const unknown = await c.call(recoveryRequest.POST, { body: { identifier: 'nobody-review@example.test' } });
    expect(known.status).toBe(202);
    expect(known.body.data).toEqual({ delivery: { status: 'unavailable', channel: 'email' } });
    expect(unknown.body.data).toEqual(known.body.data);
    expect(JSON.stringify(known.body)).not.toMatch(/\d{6}/);
  });

  it('registration and re-verification are unavailable (no account that can never be verified, no code)', async () => {
    const c = new TestClient();
    const r = await c.call(register.POST, { body: { identifier: 'new-review@example.test', password: PASSWORD, display_name: 'X' } });
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe('verification_unavailable');
    const v = await member.call(verifyRequest.POST, { body: { kind: 'email' } });
    expect(JSON.stringify(v.body)).not.toContain('dev_code');
  });

  it('the dev outbox does not exist', async () => {
    const r = await new TestClient().call(devOutbox.GET, { query: { destination: member.identifier } });
    expect(r.status).toBe(404);
  });

  it('demo sign-in is absent; a seeded account signs in with its password', async () => {
    const c = new TestClient();
    expect((await c.call(demoUsers.GET)).status).toBe(404);
    expect((await c.call(session.GET)).body.data.demo_mode).toBe(false);
    expect((await c.call(login.POST, { body: { identifier: member.identifier, password: PASSWORD } })).status).toBe(200);
  });

  it('WhatsApp MFA is unavailable and shows no code; the fixed demo code is never accepted; TOTP works', async () => {
    const s = await newSession(admin.identifier);
    expect((await s.call(overview.GET)).body.error.code).toBe('mfa_required');
    const sent = await s.call(mfaSend.POST, { body: {} });
    expect(sent.status).toBe(503);
    expect(JSON.stringify(sent.body)).not.toContain('dev_code');
    expect((await s.call(mfaVerify.POST, { body: { code: DEMO_MFA_CODE } })).status).toBe(422);

    // Even with the embedded (PGlite) driver flag, a deployed build never uses the fixed code.
    process.env.DB_DRIVER = 'pglite'; resetEnvCache();
    expect(demoMfa()).toBe(false);
    delete process.env.DB_DRIVER; resetEnvCache();

    // TOTP: enrol (password step-up just happened at sign-in) and activate.
    const en = await s.call(mfaEnroll.POST, { body: {} });
    expect(en.status).toBe(200);
    expect((await s.call(mfaActivate.POST, { body: { code: totpCode(en.body.data.secret) } })).status).toBe(200);
    expect((await s.call(overview.GET)).status).toBe(200);
  });
});

describe('LUMA-AUDIT-028: once an authenticator app is enrolled, only its codes count', () => {
  afterAll(() => local());
  it('a WhatsApp code is neither sent nor accepted after TOTP enrolment', async () => {
    local();
    process.env.PLATFORM_MFA_REQUIRED = 'true'; resetEnvCache();
    try {
      const admin = await platformUser('platform_owner', 'TOTP only');
      const phone = `+9665${String(Date.now() + 7).slice(-8)}`;
      await db().updateTable('users').set({ phone }).where('id', '=', await userIdOf(admin.identifier)).execute();
      // Before enrolment the WhatsApp code works (local dev echo shows it).
      const before = await admin.call(mfaSend.POST, { body: {} });
      expect(before.status).toBe(200);
      const en = await admin.call(mfaEnroll.POST, { body: {} });
      expect((await admin.call(mfaActivate.POST, { body: { code: totpCode(en.body.data.secret) } })).status).toBe(200);

      const second = await newSession(admin.identifier);
      const send = await second.call(mfaSend.POST, { body: {} });
      expect(send.status).toBe(422);
      expect(send.body.error.code).toBe('mfa_use_authenticator');
      // A still-valid WhatsApp code issued before enrolment is refused.
      const old = before.body.data.delivery.dev_code as string;
      expect((await second.call(mfaVerify.POST, { body: { code: old } })).body.error.code).toBe('mfa_code_invalid');
      expect((await second.call(mfaVerify.POST, { body: { code: totpCode(en.body.data.secret, Date.now() + 30_000) } })).status).toBe(200);
    } finally {
      delete process.env.PLATFORM_MFA_REQUIRED; resetEnvCache();
    }
  });
});
