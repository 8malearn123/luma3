import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import pg from 'pg';
import { e2eEnv } from '../../playwright.config';

/**
 * Rebuilds the disposable E2E database and loads demo data. Refuses any
 * database whose name does not end in `_e2e`, and never runs in production.
 * The database itself must exist (created once by an operator; see RUNBOOK.md).
 */
export default async function globalSetup() {
  const url = new URL(e2eEnv.DATABASE_OWNER_URL);
  const name = url.pathname.slice(1);
  if (!name.endsWith('_e2e')) throw new Error(`Refusing to reset "${name}": E2E databases must end with _e2e`);
  if (process.env.APP_ENV === 'production') throw new Error('Refusing to run E2E setup in production');
  if (!['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('E2E database must be local');

  const c = new pg.Client({ connectionString: e2eEnv.DATABASE_OWNER_URL });
  await c.connect();
  await c.query('drop schema if exists app cascade');
  await c.query('drop schema public cascade');
  await c.query('create schema public');
  await c.query(`grant usage on schema public to ${pg.escapeIdentifier(e2eEnv.DB_APP_ROLE)}`);
  await c.end();

  mkdirSync('.e2e', { recursive: true });
  const env = { ...process.env, ...e2eEnv };
  execFileSync('pnpm', ['-s', 'exec', 'tsx', 'scripts/migrate.ts'], { env, stdio: 'inherit' });
  execFileSync('pnpm', ['-s', 'exec', 'tsx', 'scripts/seed.ts'], { env, stdio: 'inherit' });
}
