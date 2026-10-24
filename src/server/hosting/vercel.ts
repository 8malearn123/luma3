import { createHmac } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Zero-configuration defaults for a Vercel project with the Neon integration.
 * The integration injects the database OWNER's connection strings; from the
 * owner's password we deterministically derive (never print) the secrets the
 * app needs, and point the app at the non-owner `luma_app` role so row-level
 * security applies. Anything set explicitly in the environment wins.
 * Used by env() at runtime and by scripts/vercel-setup.ts at build time.
 */
export const VERCEL_APP_ROLE = process.env.DB_APP_ROLE || 'luma_app';

type Env = Record<string, string | undefined>;

export function neonOwnerUrls(e: Env) {
  const pooled = e.DATABASE_URL || e.POSTGRES_URL;
  const direct = e.DATABASE_URL_UNPOOLED || e.POSTGRES_URL_NON_POOLING || pooled;
  return { pooled, direct };
}

function derive(ownerUrl: string, label: string) {
  const pw = decodeURIComponent(new URL(ownerUrl).password);
  return createHmac('sha256', pw).update(`luma:${label}`).digest('base64url');
}

/** Password of the runtime role, derived from the owner's password. */
export function derivedAppPassword(ownerUrl: string) {
  return derive(ownerUrl, 'app-role-password');
}

export function appRoleUrl(ownerUrl: string) {
  const u = new URL(ownerUrl);
  u.username = VERCEL_APP_ROLE;
  u.password = derivedAppPassword(ownerUrl);
  return u.toString();
}

/** Mutates a copy of the raw environment with Vercel + Neon defaults (no-op elsewhere). */
export function applyVercelDefaults(raw: Env): Env {
  if (raw.VERCEL !== '1' || raw.LUMA_DATABASE_URL) return raw;
  const { pooled } = neonOwnerUrls(raw);
  if (!pooled) return embeddedDefaults(raw);
  const out: Env = { ...raw };
  // The injected DATABASE_URL is the table owner; the app connects as luma_app instead.
  out.DATABASE_URL = appRoleUrl(pooled);
  out.DB_APP_ROLE ??= VERCEL_APP_ROLE;
  out.APP_ENV ??= 'review';
  out.AUTH_SECRET ??= derive(pooled, 'auth-secret');
  out.PAYMENT_SANDBOX_WEBHOOK_SECRET ??= derive(pooled, 'sandbox-webhook');
  out.STORAGE_DRIVER ??= 'db';
  out.DB_POOL_MAX ??= '3';
  if (out.APP_ENV !== 'production') out.DEV_OTP_ECHO ??= 'true';
  const host = out.VERCEL_PROJECT_PRODUCTION_URL || out.VERCEL_URL;
  if (host) out.APP_URL ??= `https://${host}`;
  return out;
}

/**
 * No database attached: run the embedded demo database (PGlite) built at deploy
 * time by scripts/build-demo-db.ts, with the secret generated in that build.
 */
function embeddedDefaults(raw: Env): Env {
  const out: Env = { ...raw };
  out.DB_DRIVER ??= 'pglite';
  out.DATABASE_URL ??= 'pglite://embedded';
  out.DB_APP_ROLE ??= 'luma_app';
  const secretFile = path.join(process.cwd(), '.demo-db', 'secret');
  if (!out.AUTH_SECRET && existsSync(secretFile)) out.AUTH_SECRET = readFileSync(secretFile, 'utf8').trim();
  if (out.AUTH_SECRET) out.PAYMENT_SANDBOX_WEBHOOK_SECRET ??= createHmac('sha256', out.AUTH_SECRET).update('luma:sandbox-webhook').digest('base64url');
  out.APP_ENV ??= 'review';
  out.STORAGE_DRIVER ??= 'db';
  if (out.APP_ENV !== 'production') {
    out.DEV_OTP_ECHO ??= 'true';
    // Fake, temporary data only: one-click sign-in as the seeded demo accounts on the login page.
    out.DEMO_MODE ??= 'true';
  }
  const host = out.VERCEL_PROJECT_PRODUCTION_URL || out.VERCEL_URL;
  if (host) out.APP_URL ??= `https://${host}`;
  return out;
}
