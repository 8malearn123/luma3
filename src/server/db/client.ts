import { Kysely, PostgresDialect, sql, type Transaction } from 'kysely';
import pg from 'pg';
import { env } from '../env';
import type { DB } from './schema.generated';

export type Database = DB;
export type Tx = Transaction<DB>;

// ── Type parsing ────────────────────────────────────────────────────────────
// int8 → number (money is stored as integer minor units; anything outside the
// safe-integer range is a bug, so fail loudly instead of silently rounding).
pg.types.setTypeParser(20, (v: string) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error(`int8 value out of safe range: ${v}`);
  return n;
});
// numeric → number (inventory quantities, 3dp). Arithmetic happens in SQL.
pg.types.setTypeParser(1700, (v: string) => Number(v));
// date → 'YYYY-MM-DD' string; never shift calendar dates through local time.
pg.types.setTypeParser(1082, (v: string) => v);

const globalForDb = globalThis as unknown as { __lumaDb?: Kysely<DB>; __lumaPool?: pg.Pool };

function createPool() {
  return new pg.Pool({
    connectionString: env().DATABASE_URL,
    max: Number(process.env.DB_POOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
    statement_timeout: 15_000,
    application_name: 'luma',
  });
}

export function pool(): pg.Pool {
  if (!globalForDb.__lumaPool) globalForDb.__lumaPool = createPool();
  return globalForDb.__lumaPool;
}

/**
 * Root Kysely instance. Queries against tenant-owned tables outside
 * withTenant()/withSystem() return no rows because of row-level security.
 */
export function db(): Kysely<DB> {
  if (!globalForDb.__lumaDb) {
    globalForDb.__lumaDb = new Kysely<DB>({ dialect: new PostgresDialect({ pool: pool() }) });
  }
  return globalForDb.__lumaDb;
}

export async function closeDb() {
  await globalForDb.__lumaDb?.destroy();
  globalForDb.__lumaDb = undefined;
  globalForDb.__lumaPool = undefined;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

type TxOptions = { isolation?: 'read committed' | 'repeatable read' | 'serializable' };

async function scoped<T>(settings: Record<string, string>, fn: (trx: Tx) => Promise<T>, opts?: TxOptions): Promise<T> {
  let builder = db().transaction();
  if (opts?.isolation) builder = builder.setIsolationLevel(opts.isolation);
  return builder.execute(async (trx) => {
    for (const [k, v] of Object.entries(settings)) {
      await sql`select set_config(${k}, ${v}, true)`.execute(trx);
    }
    return fn(trx);
  });
}

/**
 * Runs fn in a transaction scoped to one tenant. The tenant id MUST come from a
 * resolved membership, support grant, published storefront or verified job —
 * never directly from request input.
 */
export function withTenant<T>(tenantId: string, fn: (trx: Tx) => Promise<T>, opts?: TxOptions): Promise<T> {
  if (!isUuid(tenantId)) throw new Error('withTenant requires a tenant uuid');
  return scoped({ 'app.tenant_id': tenantId, 'app.scope': 'tenant' }, fn, opts);
}

/**
 * Cross-tenant system scope. Only for reviewed code paths: platform admin,
 * webhook intake before tenant resolution, scheduled job fan-out, migrations of
 * data. Callers pass a reason that is useful in logs and code review.
 */
export function withSystem<T>(reason: string, fn: (trx: Tx) => Promise<T>, opts?: TxOptions): Promise<T> {
  if (!reason) throw new Error('withSystem requires a reason');
  return scoped({ 'app.scope': 'system' }, fn, opts);
}

/** Transaction with no tenant scope: for central tables (users, sessions, plans). */
export function withCentral<T>(fn: (trx: Tx) => Promise<T>, opts?: TxOptions): Promise<T> {
  return scoped({ 'app.scope': 'central' }, fn, opts);
}

export { sql };
