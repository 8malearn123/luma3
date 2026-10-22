import pg from 'pg';
import { loadDotEnv } from './load-env';

/**
 * Creates (or re-keys) the runtime database role on a hosted PostgreSQL such as
 * Neon. The app must connect as a role that does NOT own the tables, so row-level
 * security applies; migrations keep running as the owner (DATABASE_OWNER_URL).
 * Input: DATABASE_OWNER_URL, APP_DB_PASSWORD, optional DB_APP_ROLE (default luma_app).
 * Never prints the password or connection strings.
 */
loadDotEnv();
const ownerUrl = process.env.DATABASE_OWNER_URL;
const password = process.env.APP_DB_PASSWORD;
const role = process.env.DB_APP_ROLE || 'luma_app';
if (!ownerUrl || !password) {
  console.error('DATABASE_OWNER_URL and APP_DB_PASSWORD are required');
  process.exit(1);
}
if (!/^[a-z_][a-z0-9_]*$/.test(role)) {
  console.error('DB_APP_ROLE must be a plain lower-case identifier');
  process.exit(1);
}
if (password.length < 16) {
  console.error('APP_DB_PASSWORD must be at least 16 characters');
  process.exit(1);
}

const c = new pg.Client({ connectionString: ownerUrl });
await c.connect();
try {
  const exists = (await c.query('select 1 from pg_roles where rolname = $1', [role])).rowCount;
  const ident = c.escapeIdentifier(role);
  const lit = c.escapeLiteral(password);
  await c.query(exists ? `alter role ${ident} with login password ${lit}` : `create role ${ident} with login password ${lit} nosuperuser nocreatedb nocreaterole nobypassrls`);
  const { rows } = await c.query<{ db: string }>('select current_database() as db');
  await c.query(`grant connect on database ${c.escapeIdentifier(rows[0]!.db)} to ${ident}`);
  console.log(`[db] runtime role "${role}" ${exists ? 'updated' : 'created'}; migrations grant it table access.`);
} finally {
  await c.end();
}
