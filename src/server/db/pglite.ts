import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { PGlite, types, type PGliteInterface } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import {
  CompiledQuery,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type DatabaseConnection,
  type Dialect,
  type Driver,
  type Kysely,
  type QueryResult,
} from 'kysely';

/**
 * Embedded PostgreSQL (PGlite, WASM) for zero-infrastructure demos — e.g. a
 * Vercel deployment with no database attached (DB_DRIVER=pglite).
 *
 * - Same schema, migrations, RLS and SQL as production PostgreSQL. The app runs
 *   as the non-owner role (SET ROLE), so row-level security still applies.
 * - One connection: queries are serialised by a lock. A transaction holds the
 *   lock; code that calls db() inside it is handed that same transaction (see
 *   client.ts), so nesting cannot deadlock.
 * - Data lives in this server instance's memory, starting from a snapshot built
 *   at deploy time (scripts/build-demo-db.ts). Changes are temporary.
 */

export const PGLITE_SNAPSHOT = path.join(process.cwd(), '.demo-db', 'luma.tar.gz');

const parsers = {
  // Same conventions as the pg driver (client.ts).
  [types.INT8]: (v: string) => {
    const n = Number(v);
    if (!Number.isSafeInteger(n)) throw new Error(`int8 value out of safe range: ${v}`);
    return n;
  },
  [types.NUMERIC]: (v: string) => Number(v),
  [types.DATE]: (v: string) => v,
};

export async function createPglite(opts: { snapshot?: Buffer | null } = {}): Promise<PGlite> {
  return PGlite.create({
    extensions: { btree_gist, citext, pgcrypto },
    parsers,
    ...(opts.snapshot ? { loadDataDir: new Blob([new Uint8Array(opts.snapshot)]) } : {}),
  });
}

/** Adapter so the migrator can run against PGlite (multi-statement files via exec). */
export function pgliteSqlClient(db: PGliteInterface) {
  return {
    async query<R = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: R[] }> {
      if (params?.length) return db.query<R>(text, params);
      const results = await db.exec(text);
      return { rows: (results.at(-1)?.rows ?? []) as R[] };
    },
    async end() {},
  };
}

const g = globalThis as unknown as { __lumaPglite?: Promise<PGlite> };

/** Registers an already-prepared instance (build script). */
export function registerPglite(instance: PGlite) {
  g.__lumaPglite = Promise.resolve(instance);
}

/**
 * The process-wide instance: the deploy-time snapshot when present, otherwise
 * an empty database migrated on first use. Always connected as the app role.
 */
export function pgliteInstance(appRole: string): Promise<PGlite> {
  g.__lumaPglite ??= (async () => {
    const snapshot = existsSync(PGLITE_SNAPSHOT) ? readFileSync(PGLITE_SNAPSHOT) : null;
    const db = await createPglite({ snapshot });
    if (!snapshot) {
      const { migrate } = await import('./migrator');
      await db.exec(`do $$ begin if not exists (select 1 from pg_roles where rolname = '${appRole}') then create role ${appRole}; end if; end $$`);
      await migrate({ client: pgliteSqlClient(db), appRole });
    }
    await db.exec(`set role ${appRole}`);
    return db;
  })();
  return g.__lumaPglite;
}

class PgliteConnection implements DatabaseConnection {
  constructor(private db: PGlite) {}
  async executeQuery<R>(q: CompiledQuery): Promise<QueryResult<R>> {
    const r = await this.db.query<R>(q.sql, [...q.parameters]);
    return { rows: r.rows, ...(r.affectedRows !== undefined ? { numAffectedRows: BigInt(r.affectedRows) } : {}) };
  }
  // eslint-disable-next-line require-yield
  async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error('streaming is not supported by the embedded database');
  }
}

class PgliteDriver implements Driver {
  private db!: PGlite;
  private tail: Promise<void> = Promise.resolve();
  private releases = new WeakMap<DatabaseConnection, () => void>();
  constructor(private appRole: string) {}
  async init() {
    this.db = await pgliteInstance(this.appRole);
  }
  async acquireConnection(): Promise<DatabaseConnection> {
    let release!: () => void;
    const prev = this.tail;
    this.tail = new Promise<void>((r) => (release = r));
    await prev;
    const conn = new PgliteConnection(this.db);
    this.releases.set(conn, release);
    return conn;
  }
  async beginTransaction(conn: DatabaseConnection) {
    await conn.executeQuery(CompiledQuery.raw('begin'));
  }
  async commitTransaction(conn: DatabaseConnection) {
    await conn.executeQuery(CompiledQuery.raw('commit'));
  }
  async rollbackTransaction(conn: DatabaseConnection) {
    await conn.executeQuery(CompiledQuery.raw('rollback'));
  }
  async releaseConnection(conn: DatabaseConnection) {
    this.releases.get(conn)?.();
  }
  // The instance is process-wide and outlives a Kysely instance (closeDb in scripts).
  async destroy() {}
}

export class PgliteDialect implements Dialect {
  constructor(private appRole: string) {}
  createAdapter() {
    return new PostgresAdapter();
  }
  createDriver() {
    return new PgliteDriver(this.appRole);
  }
  createQueryCompiler() {
    return new PostgresQueryCompiler();
  }
  createIntrospector(db: Kysely<unknown>) {
    return new PostgresIntrospector(db);
  }
}
