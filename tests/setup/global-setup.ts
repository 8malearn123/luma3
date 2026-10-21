import pg from 'pg';
import { migrate } from '../../src/server/db/migrator';

/**
 * Migrates the test database and clears data from previous runs. Refuses to
 * touch any database whose name does not end in "_test".
 */
export default async function setup() {
  const url = process.env.TEST_DATABASE_OWNER_URL ?? 'postgres://luma_owner:luma_owner_dev@localhost:5432/luma_test';
  const dbName = new URL(url).pathname.slice(1);
  if (!dbName.endsWith('_test')) throw new Error(`Refusing to reset non-test database "${dbName}"`);
  await migrate({ connectionString: url, appRole: 'luma_app' });
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const { rows } = await client.query<{ tablename: string }>(
      `select tablename from pg_tables where schemaname = 'public' and tablename <> 'schema_migrations'`);
    if (rows.length) {
      // TRUNCATE bypasses row-level triggers (append-only guards are UPDATE/DELETE triggers).
      await client.query(`truncate ${rows.map((r) => `"${r.tablename}"`).join(', ')} restart identity cascade`);
    }
  } finally {
    await client.end();
  }
}
