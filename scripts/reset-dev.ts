import pg from 'pg';
import { loadDotEnv } from './load-env';
import { migrate } from '../src/server/db/migrator';

/**
 * Drops and recreates the public schema of a LOCAL development database, then re-migrates.
 * Guards: never in production, only databases whose name ends in `_dev`, only localhost,
 * and only with an explicit `--confirm=<database name>` flag typed by a person.
 */
loadDotEnv();
const url = process.env.DATABASE_OWNER_URL;
if (!url) {
  console.error('DATABASE_OWNER_URL is required');
  process.exit(1);
}
if (process.env.APP_ENV === 'production' || process.env.NODE_ENV === 'production') {
  console.error('Refusing: reset is never allowed in production.');
  process.exit(1);
}
const parsed = new URL(url);
const dbName = parsed.pathname.replace(/^\//, '');
if (!dbName.endsWith('_dev')) {
  console.error(`Refusing: "${dbName}" is not a development database (name must end with _dev).`);
  process.exit(1);
}
if (!['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)) {
  console.error(`Refusing: host "${parsed.hostname}" is not local.`);
  process.exit(1);
}
const confirm = process.argv.find((a) => a.startsWith('--confirm='))?.slice('--confirm='.length);
if (confirm !== dbName) {
  console.error(`This permanently deletes all data in "${dbName}". Re-run with --confirm=${dbName} to proceed.`);
  process.exit(1);
}

const appRole = process.env.DB_APP_ROLE || 'luma_app';
const client = new pg.Client({ connectionString: url });
await client.connect();
await client.query('DROP SCHEMA IF EXISTS app CASCADE');
await client.query('DROP SCHEMA public CASCADE');
await client.query('CREATE SCHEMA public');
await client.query(`GRANT USAGE ON SCHEMA public TO ${pg.escapeIdentifier(appRole)}`);
await client.end();
await migrate({ connectionString: url, appRole, log: (m) => console.log(`[migrate] ${m}`) });
console.log(`Reset ${dbName}. Run pnpm db:seed to load demo data.`);
process.exit(0);
