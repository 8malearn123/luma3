import { describe, expect, it } from 'vitest';
import { applyVercelDefaults, appRoleUrl } from '@/server/hosting/vercel';

const owner = 'postgresql://neondb_owner:owner-secret@ep-x-pooler.neon.tech/neondb?sslmode=require';

describe('Vercel + Neon zero-config defaults', () => {
  it('does nothing outside Vercel or when LUMA_DATABASE_URL is set', () => {
    expect(applyVercelDefaults({ DATABASE_URL: owner })).toEqual({ DATABASE_URL: owner });
    const manual = { VERCEL: '1', DATABASE_URL: owner, LUMA_DATABASE_URL: 'x' };
    expect(applyVercelDefaults(manual)).toBe(manual);
  });

  it('connects as the non-owner role with derived secrets, keeping explicit values', () => {
    const e = applyVercelDefaults({ VERCEL: '1', DATABASE_URL: owner, VERCEL_URL: 'luma3-abc.vercel.app', APP_ENV: 'review', DEV_OTP_ECHO: 'false' });
    const u = new URL(e.DATABASE_URL!);
    expect(u.username).toBe('luma_app');
    expect(u.password).not.toBe('owner-secret');
    expect(u.host).toBe('ep-x-pooler.neon.tech');
    expect(e.AUTH_SECRET!.length).toBeGreaterThanOrEqual(32);
    expect(e.AUTH_SECRET).not.toContain('owner-secret');
    expect(e.STORAGE_DRIVER).toBe('db');
    expect(e.APP_URL).toBe('https://luma3-abc.vercel.app');
    expect(e.DEV_OTP_ECHO).toBe('false'); // explicit setting wins
    expect(appRoleUrl(owner)).toBe(e.DATABASE_URL); // deterministic across build and runtime
  });

  it('never enables on-screen codes or the demo switcher in production', () => {
    const prod = applyVercelDefaults({ VERCEL: '1', DATABASE_URL: owner, APP_ENV: 'production' });
    expect(prod.DEV_OTP_ECHO).toBeUndefined();
    expect(prod.DEMO_MODE).toBeUndefined();
  });

  it('turns the demo switcher on in review builds unless set explicitly', () => {
    expect(applyVercelDefaults({ VERCEL: '1', DATABASE_URL: owner }).DEMO_MODE).toBe('true');
    expect(applyVercelDefaults({ VERCEL: '1', DATABASE_URL: owner, DEMO_MODE: 'false' }).DEMO_MODE).toBe('false');
  });

  it('with no database attached, runs the embedded demo database', () => {
    const e = applyVercelDefaults({ VERCEL: '1', VERCEL_URL: 'luma3-x.vercel.app', AUTH_SECRET: 'from-build-secret-from-build-secret-01' });
    expect(e).toMatchObject({ DB_DRIVER: 'pglite', DATABASE_URL: 'pglite://embedded', DB_APP_ROLE: 'luma_app', APP_ENV: 'review', STORAGE_DRIVER: 'db', DEV_OTP_ECHO: 'true', DEMO_MODE: 'true', APP_URL: 'https://luma3-x.vercel.app' });
    expect(e.PAYMENT_SANDBOX_WEBHOOK_SECRET).toBeTruthy();
    expect(applyVercelDefaults({ VERCEL: '1', APP_ENV: 'production' }).DEMO_MODE).toBeUndefined();
  });
});
