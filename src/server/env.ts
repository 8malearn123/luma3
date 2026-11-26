import { z } from 'zod';
import { applyVercelDefaults } from './hosting/vercel';

/**
 * Server-side environment. Parsed once and frozen. Import only from server code;
 * nothing here may reach the browser bundle.
 */
const bool = z
  .enum(['true', 'false', '1', '0', ''])
  .optional()
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  /**
   * development / test: local machines only (never on a hosted deployment). review: a private, deployed
   * review build (HTTPS, secure cookies, mandatory admin MFA, never indexed) that still uses the payment
   * sandbox; demo accounts sign in with a password only and no one-time code is ever shown on screen.
   * production: real customers; sandbox, demo switcher and on-screen codes are forced off.
   */
  APP_ENV: z.enum(['development', 'test', 'review', 'production']).default('development'),
  APP_URL: z.string().url().default('http://localhost:3000'),
  DATABASE_URL: z.string().min(1),
  /** pg: a PostgreSQL server (default). pglite: embedded in-process PostgreSQL for zero-infrastructure demos. */
  DB_DRIVER: z.enum(['pg', 'pglite']).default('pg'),
  DATABASE_OWNER_URL: z.string().optional(),
  DB_APP_ROLE: z.string().regex(/^[a-z_][a-z0-9_]*$/).default('luma_app'),
  AUTH_SECRET: z.string().min(32, 'AUTH_SECRET must be at least 32 characters'),
  /** Local development only: one-click sign-in as seeded demo accounts. Refused on deployed builds. */
  DEMO_MODE: bool,
  /** Local development only: one-time codes shown on screen / in the dev outbox. Refused on deployed builds. */
  DEV_OTP_ECHO: bool,
  /** Platform staff must enrol in MFA before using the admin area. Always on in production. */
  PLATFORM_MFA_REQUIRED: bool,
  /** Number of trusted reverse proxies that append to X-Forwarded-For (0 = ignore the header). */
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(1),
  /** local: files on disk (development). db: files in PostgreSQL (serverless hosts such as Vercel have no writable disk). */
  STORAGE_DRIVER: z.enum(['local', 'db']).default('local'),
  /** Shared secret for the scheduled job endpoint (/api/v1/internal/cron). Unset = endpoint disabled. */
  CRON_SECRET: z.string().min(24).optional(),
  STORAGE_LOCAL_DIR: z.string().default('./storage'),
  EMAIL_PROVIDER: z.enum(['none']).default('none'),
  SMS_PROVIDER: z.enum(['none']).default('none'),
  WHATSAPP_PROVIDER: z.enum(['none']).default('none'),
  OPENAI_API_KEY: z.string().optional().default(''),
  OPENAI_MODEL: z.string().optional().default(''),
  /** Optional stronger model for 'strong' tier prompts (Loom monthly plan assembly); falls back to OPENAI_MODEL. */
  OPENAI_MODEL_STRONG: z.string().optional().default(''),
  OPENAI_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
  OPENAI_PRICE_INPUT_PER_MTOK: z.coerce.number().optional(),
  OPENAI_PRICE_OUTPUT_PER_MTOK: z.coerce.number().optional(),
  AI_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(45_000),
  PAYMENT_SANDBOX_WEBHOOK_SECRET: z.string().optional().default(''),
  /** Meta app for the official Instagram API (storefront Instagram section). Unset = not connectable; the section shows the profile link. */
  INSTAGRAM_APP_ID: z.string().optional().default(''),
  INSTAGRAM_APP_SECRET: z.string().optional().default(''),
});

export type Env = z.infer<typeof schema> & {
  isProduction: boolean;
  /**
   * Served to others (review or production, or running on a hosting platform such as Vercel,
   * preview deployments included): secure cookies, mandatory admin MFA, no development auth aids.
   */
  isDeployed: boolean;
  /** One-click demo sign-in — local development only, never on a deployed build. */
  demoEnabled: boolean;
  /** One-time codes echoed on screen / dev outbox — local development only, never on a deployed build. */
  devOtpEcho: boolean;
  /** Platform staff must have MFA enabled (forced on in production). */
  platformMfaRequired: boolean;
};

function emptyToUndefined(source: NodeJS.ProcessEnv) {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(source)) out[k] = v === '' ? undefined : v;
  return out;
}

let cached: Env | null = null;

/**
 * Running on a hosting platform rather than a developer machine. Vercel sets VERCEL=1 and
 * VERCEL_ENV (production | preview) on every build and function; `vercel dev` (local) reports
 * VERCEL_ENV=development and is treated as local.
 */
export function isHostedRuntime(raw: Record<string, string | undefined>) {
  if (raw.VERCEL_ENV === 'development') return false;
  return raw.VERCEL === '1' || raw.VERCEL_ENV === 'production' || raw.VERCEL_ENV === 'preview';
}

const LOCAL_APP_ENVS = new Set(['development', 'test']);

/**
 * Settings that are unsafe together. Each problem names the variable first ("NAME: …") so
 * /api/v1/health can report which setting to fix without exposing any value.
 */
export function unsafeCombinations(raw: Record<string, string | undefined>, e: z.infer<typeof schema>): string[] {
  const problems: string[] = [];
  const hosted = isHostedRuntime(raw);
  const deployed = hosted || !LOCAL_APP_ENVS.has(e.APP_ENV);
  if (hosted && LOCAL_APP_ENVS.has(e.APP_ENV)) {
    problems.push(raw.APP_ENV
      ? `APP_ENV: "${e.APP_ENV}" is for local machines only; set APP_ENV=review (private review build) or APP_ENV=production on a hosted deployment`
      : 'APP_ENV: not set; a hosted production deployment must set APP_ENV=review or APP_ENV=production explicitly');
  }
  if (deployed && e.DEV_OTP_ECHO) {
    problems.push('DEV_OTP_ECHO: on-screen one-time codes are a local-development aid and are refused on deployed builds; remove the variable (codes are only ever sent through a messaging provider)');
  }
  if (deployed && e.DEMO_MODE) {
    problems.push('DEMO_MODE: one-click demo sign-in is local-only and refused on deployed builds; remove the variable (demo accounts sign in with their password)');
  }
  if (deployed && e.PAYMENT_SANDBOX_WEBHOOK_SECRET && e.PAYMENT_SANDBOX_WEBHOOK_SECRET.length < 24) {
    problems.push('PAYMENT_SANDBOX_WEBHOOK_SECRET: must be at least 24 random characters on deployed builds');
  }
  if (deployed && e.PAYMENT_SANDBOX_WEBHOOK_SECRET && e.PAYMENT_SANDBOX_WEBHOOK_SECRET === e.AUTH_SECRET) {
    problems.push('PAYMENT_SANDBOX_WEBHOOK_SECRET: must differ from AUTH_SECRET');
  }
  return problems;
}

export function env(): Env {
  if (cached) return cached;
  const raw = applyVercelDefaults(emptyToUndefined(process.env));
  // Hosts that inject their own DATABASE_URL (e.g. Vercel's Neon integration, which uses the
  // table owner) can point the app at the non-owner runtime role with LUMA_DATABASE_URL.
  if (raw.LUMA_DATABASE_URL) raw.DATABASE_URL = raw.LUMA_DATABASE_URL;
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.path[0] === 'AUTH_SECRET' && raw.AUTH_SECRET === undefined
      ? 'required — set an independent random value of 32+ characters (e.g. `openssl rand -base64 32`)' : i.message}`).join('; ');
    throw new Error(`Invalid server environment: ${issues}`);
  }
  const e = parsed.data;
  // Refuse to start rather than silently enabling development auth behaviour on a deployed build.
  const problems = unsafeCombinations(raw, e);
  if (problems.length) throw new Error(`Invalid server environment: ${problems.join('; ')}`);
  const isProduction = e.APP_ENV === 'production';
  const isDeployed = isHostedRuntime(raw) || !LOCAL_APP_ENVS.has(e.APP_ENV);
  cached = Object.freeze({
    ...e,
    isProduction,
    isDeployed,
    // Belt and braces: unsafeCombinations() already refuses these on deployed builds.
    demoEnabled: !isDeployed && e.DEMO_MODE,
    devOtpEcho: !isDeployed && e.DEV_OTP_ECHO,
    platformMfaRequired: isDeployed || e.PLATFORM_MFA_REQUIRED,
  });
  return cached;
}

/** Test helper: forget the cached env after mutating process.env. */
export function resetEnvCache() {
  cached = null;
}
