import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

/**
 * Forward-only SQL migration runner.
 *
 * - Files in db/migrations are applied in lexical order, each in its own transaction.
 * - Applied files are checksummed; editing an applied migration is refused instead of
 *   silently diverging. Fixes go into a new migration.
 * - `{{APP_ROLE}}` is replaced with the runtime role name so grants follow the deployment.
 * - Nothing here drops or resets data.
 */
export async function migrate(opts: { connectionString: string; appRole: string; log?: (m: string) => void }) {
  const log = opts.log ?? (() => {});
  if (!/^[a-z_][a-z0-9_]*$/.test(opts.appRole)) throw new Error('invalid app role name');
  const dir = path.resolve(process.cwd(), 'db/migrations');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const client = new pg.Client({ connectionString: opts.connectionString });
  await client.connect();
  try {
    await client.query(`create table if not exists schema_migrations (
      filename text primary key,
      checksum text not null,
      applied_at timestamptz not null default now()
    )`);
    // Serialise concurrent runners (e.g. parallel test workers, two deploys).
    await client.query('select pg_advisory_lock(727274)');
    const { rows } = await client.query<{ filename: string; checksum: string }>('select filename, checksum from schema_migrations');
    const applied = new Map(rows.map((r) => [r.filename, r.checksum]));
    let count = 0;
    for (const file of files) {
      const raw = await readFile(path.join(dir, file), 'utf8');
      const checksum = createHash('sha256').update(raw).digest('hex');
      const prev = applied.get(file);
      if (prev) {
        if (prev !== checksum) throw new Error(`Migration ${file} was modified after being applied. Create a new migration instead.`);
        continue;
      }
      const sql = raw.replaceAll('{{APP_ROLE}}', opts.appRole);
      log(`applying ${file}`);
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query('insert into schema_migrations (filename, checksum) values ($1, $2)', [file, checksum]);
        await client.query('commit');
        count++;
      } catch (err) {
        await client.query('rollback');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }
    log(count ? `applied ${count} migration(s)` : 'database is up to date');
    return count;
  } finally {
    await client.query('select pg_advisory_unlock(727274)').catch(() => {});
    await client.end();
  }
}
