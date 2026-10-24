import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Builds the embedded demo database (DB_DRIVER=pglite): migrates a fresh
 * in-process PostgreSQL, loads the demo data with the regular seed, and saves a
 * compressed snapshot to .demo-db/luma.tar.gz. The server starts from that
 * snapshot, so a deployment needs no database at all. Demo passwords are random
 * and written nowhere (sign in through password recovery).
 */
const outDir = path.join(process.cwd(), '.demo-db');
mkdirSync(outDir, { recursive: true });
// One secret per build, shared by this script and the server (it signs sessions and codes).
const secretFile = path.join(outDir, 'secret');
if (!existsSync(secretFile)) writeFileSync(secretFile, randomBytes(32).toString('base64url'), { mode: 0o600 });

const appRole = process.env.DB_APP_ROLE || 'luma_app';
Object.assign(process.env, {
  DB_DRIVER: 'pglite',
  DATABASE_URL: 'pglite://embedded',
  DB_APP_ROLE: appRole,
  AUTH_SECRET: readFileSync(secretFile, 'utf8'),
  APP_ENV: process.env.APP_ENV ?? 'review',
  STORAGE_DRIVER: 'db',
  SEED_CREDENTIALS_JSON: path.join(outDir, '.seed-credentials-discarded.json'),
});

const t0 = Date.now();
const { createPglite, pgliteSqlClient, registerPglite } = await import('../src/server/db/pglite');
const { migrate } = await import('../src/server/db/migrator');
const pg = await createPglite();
await pg.exec(`create role ${appRole}`);
await migrate({ client: pgliteSqlClient(pg), appRole, log: (m) => console.log(`[demo-db] ${m}`) });
await pg.exec(`set role ${appRole}`);
registerPglite(pg);

await import('./seed');

await pg.exec('reset role');
const dump = await pg.dumpDataDir('gzip');
const file = path.join(outDir, 'luma.tar.gz');
writeFileSync(file, Buffer.from(await dump.arrayBuffer()));
const { rmSync } = await import('node:fs');
rmSync(path.join(outDir, '.seed-credentials-discarded.json'), { force: true });
console.log(`[demo-db] snapshot ${(dump.size / 1024 / 1024).toFixed(1)} MB written in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
process.exit(0);
