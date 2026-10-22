import { z } from 'zod';

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
   * development / test: local machines. review: a private, deployed review build (HTTPS, secure cookies,
   * mandatory admin MFA, never indexed) that still uses the payment sandbox and on-screen codes.
   * production: real customers; sandbox, demo switcher and on-screen codes are forced off.
   */
  APP_ENV: z.enum(['development', 'test', 'review', 'production']).default('development'),
  APP_URL: z.string().url().default('http://localhost:3000'),
  DATABASE_URL: z.string().min(1),
  DATABASE_OWNER_URL: z.string().optional(),
  DB_APP_ROLE: z.string().regex(/^[a-z_][a-z0-9_]*$/).default('luma_app'),
  AUTH_SECRET: z.string().min(32, 'AUTH_SECRET must be at least 32 characters'),
  DEMO_MODE: bool,
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
  OPENAI_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
  OPENAI_PRICE_INPUT_PER_MTOK: z.coerce.number().optional(),
  OPENAI_PRICE_OUTPUT_PER_MTOK: z.coerce.number().optional(),
  AI_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(45_000),
  PAYMENT_SANDBOX_WEBHOOK_SECRET: z.string().optional().default(''),
});

export type Env = z.infer<typeof schema> & {
  isProduction: boolean;
  /** Served to others over HTTPS (review or production): secure cookies, mandatory admin MFA. */
  isDeployed: boolean;
  /** Demo role switcher — never available in production. */
  demoEnabled: boolean;
  /** Development OTP echo — never available in production. */
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

export function env(): Env {
  if (cached) return cached;
  const raw = emptyToUndefined(process.env);
  // Hosts that inject their own DATABASE_URL (e.g. Vercel's Neon integration, which uses the
  // table owner) can point the app at the non-owner runtime role with LUMA_DATABASE_URL.
  if (raw.LUMA_DATABASE_URL) raw.DATABASE_URL = raw.LUMA_DATABASE_URL;
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid server environment: ${issues}`);
  }
  const e = parsed.data;
  const isProduction = e.APP_ENV === 'production';
  const isDeployed = isProduction || e.APP_ENV === 'review';
  cached = Object.freeze({
    ...e,
    isProduction,
    isDeployed,
    demoEnabled: !isProduction && e.DEMO_MODE,
    devOtpEcho: !isProduction && e.DEV_OTP_ECHO,
    platformMfaRequired: isDeployed || e.PLATFORM_MFA_REQUIRED,
  });
  return cached;
}

/** Test helper: forget the cached env after mutating process.env. */
export function resetEnvCache() {
  cached = null;
}
