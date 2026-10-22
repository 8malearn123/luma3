import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { migrate } from '../src/server/db/migrator';
import { derivedAppPassword, neonOwnerUrls, VERCEL_APP_ROLE } from '../src/server/hosting/vercel';

/**
 * Runs during `vercel-build` (before `next build`) on a Vercel project with the
 * Neon integration: creates the non-owner runtime role, applies migrations and
 * loads the demo data once (skipped when it already exists). Prints no secrets.
 * Outside Vercel, or without a database, it does nothing.
 */
const log = (m: string) => console.log(`[vercel-setup] ${m}`);

if (process.env.VERCEL !== '1') {
  log('not running on Vercel; skipping');
  process.exit(0);
}
const { pooled, direct } = neonOwnerUrls(process.env);
if (!pooled || !direct) {
  log('no database connection injected (add Neon under Storage); skipping database setup');
  process.exit(0);
}
if (process.env.LUMA_DATABASE_URL) {
  log('LUMA_DATABASE_URL is set: database is managed manually; skipping');
  process.exit(0);
}

const c = new pg.Client({ connectionString: direct });
await c.connect();
try {
  const ident = c.escapeIdentifier(VERCEL_APP_ROLE);
  const lit = c.escapeLiteral(derivedAppPassword(pooled));
  const exists = (await c.query('select 1 from pg_roles where rolname = $1', [VERCEL_APP_ROLE])).rowCount;
  await c.query(exists ? `alter role ${ident} with login password ${lit}` : `create role ${ident} with login password ${lit}`);
  const { rows } = await c.query<{ db: string }>('select current_database() as db');
  await c.query(`grant connect on database ${c.escapeIdentifier(rows[0]!.db)} to ${ident}`);
  log(`runtime role ${VERCEL_APP_ROLE} ${exists ? 'updated' : 'created'}`);
} finally {
  await c.end();
}

await migrate({ connectionString: direct, appRole: VERCEL_APP_ROLE, log });

if (process.env.LUMA_SKIP_SEED === '1' || process.env.APP_ENV === 'production') {
  log('demo data not loaded (production or LUMA_SKIP_SEED=1)');
} else {
  // seed.ts reads the derived settings through env(); credentials go to a temp file, never the log.
  execFileSync('pnpm', ['-s', 'exec', 'tsx', 'scripts/seed.ts'], {
    stdio: 'inherit',
    env: { ...process.env, SEED_CREDENTIALS_JSON: '/tmp/luma-demo-credentials.json' },
  });
}
log('database ready');
