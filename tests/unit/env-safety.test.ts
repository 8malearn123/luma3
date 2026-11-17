import { afterEach, describe, expect, it } from 'vitest';
import { env, resetEnvCache } from '@/server/env';
import { applyVercelDefaults } from '@/server/hosting/vercel';

/**
 * LUMA-AUDIT-001 / 029: development auth aids (on-screen codes, dev outbox,
 * one-click demo sign-in, the fixed demo MFA code) exist only on a local,
 * non-deployed machine; unsafe combinations refuse to start with an
 * actionable message that names the setting (never its value).
 */
const saved = { ...process.env };
function withEnv(patch: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetEnvCache();
  return env;
}
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
  resetEnvCache();
});

const SECRET = 'independent-random-secret-0123456789abcdef';
const SANDBOX = 'independent-sandbox-secret-0123456789';

describe('deployed builds never enable development auth behaviour', () => {
  it('local development may echo codes and offer demo sign-in', () => {
    const e = withEnv({ APP_ENV: 'development', DEV_OTP_ECHO: 'true', DEMO_MODE: 'true' })();
    expect(e).toMatchObject({ isDeployed: false, devOtpEcho: true, demoEnabled: true });
  });

  it.each(['review', 'production'])('APP_ENV=%s with DEV_OTP_ECHO refuses to start', (appEnv) => {
    const e = withEnv({ APP_ENV: appEnv, DEV_OTP_ECHO: 'true', DEMO_MODE: 'false', PAYMENT_SANDBOX_WEBHOOK_SECRET: SANDBOX });
    expect(() => e()).toThrow(/DEV_OTP_ECHO: .*refused on deployed builds/);
  });

  it.each(['review', 'production'])('APP_ENV=%s with DEMO_MODE refuses to start', (appEnv) => {
    const e = withEnv({ APP_ENV: appEnv, DEV_OTP_ECHO: 'false', DEMO_MODE: 'true', PAYMENT_SANDBOX_WEBHOOK_SECRET: SANDBOX });
    expect(() => e()).toThrow(/DEMO_MODE: /);
  });

  it('a Vercel preview is a deployed build even if it claims APP_ENV=development', () => {
    const e = withEnv({ VERCEL: '1', VERCEL_ENV: 'preview', APP_ENV: 'development', DEV_OTP_ECHO: 'false', DEMO_MODE: 'false' });
    expect(() => e()).toThrow(/APP_ENV: "development" is for local machines only/);
  });

  it('review build: no echo, no demo, MFA required, secure', () => {
    const e = withEnv({ APP_ENV: 'review', DEV_OTP_ECHO: 'false', DEMO_MODE: 'false', PAYMENT_SANDBOX_WEBHOOK_SECRET: SANDBOX })();
    expect(e).toMatchObject({ isDeployed: true, devOtpEcho: false, demoEnabled: false, platformMfaRequired: true });
  });

  it('a short sandbox webhook secret is refused on deployed builds', () => {
    const e = withEnv({ APP_ENV: 'review', DEV_OTP_ECHO: 'false', DEMO_MODE: 'false', PAYMENT_SANDBOX_WEBHOOK_SECRET: 'short-secret' });
    expect(() => e()).toThrow(/PAYMENT_SANDBOX_WEBHOOK_SECRET: must be at least 24/);
  });
});

describe('Vercel + Neon: secrets are never derived from database credentials (LUMA-AUDIT-029)', () => {
  const owner = 'postgresql://neondb_owner:owner-secret@ep-x-pooler.neon.tech/neondb?sslmode=require';
  const base = { VERCEL: '1', DATABASE_URL: owner, APP_ENV: undefined, AUTH_SECRET: undefined, DEV_OTP_ECHO: undefined, DEMO_MODE: undefined, PAYMENT_SANDBOX_WEBHOOK_SECRET: undefined, LUMA_DATABASE_URL: undefined };

  it('without AUTH_SECRET the server refuses to start and says how to fix it', () => {
    const e = withEnv({ ...base, VERCEL_ENV: 'preview' });
    expect(() => e()).toThrow(/AUTH_SECRET: required — set an independent random value/);
  });

  it('the Production environment needs an explicit APP_ENV', () => {
    const e = withEnv({ ...base, VERCEL_ENV: 'production', AUTH_SECRET: SECRET });
    expect(() => e()).toThrow(/APP_ENV: not set; a hosted production deployment must set APP_ENV=review or APP_ENV=production/);
  });

  it('a preview with an explicit AUTH_SECRET runs as a review build with no codes and no sandbox secret derived', () => {
    const e = withEnv({ ...base, VERCEL_ENV: 'preview', AUTH_SECRET: SECRET })();
    expect(e).toMatchObject({ APP_ENV: 'review', isDeployed: true, devOtpEcho: false, demoEnabled: false, AUTH_SECRET: SECRET, PAYMENT_SANDBOX_WEBHOOK_SECRET: '' });
  });

  it('applyVercelDefaults derives no application secret and turns on no development aid', () => {
    const out = applyVercelDefaults({ VERCEL: '1', VERCEL_ENV: 'preview', DATABASE_URL: owner });
    expect(out.AUTH_SECRET).toBeUndefined();
    expect(out.PAYMENT_SANDBOX_WEBHOOK_SECRET).toBeUndefined();
    expect(out.DEV_OTP_ECHO).toBeUndefined();
    expect(out.DEMO_MODE).toBeUndefined();
    expect(applyVercelDefaults({ VERCEL: '1', VERCEL_ENV: 'production', DATABASE_URL: owner }).APP_ENV).toBeUndefined();
  });
});
