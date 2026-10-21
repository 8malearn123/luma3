/**
 * Grant or revoke a LUMA administrative role for an EXISTING, verified account.
 * The only way to create the first platform_owner. Audited (actor_kind 'system').
 *
 *   pnpm exec tsx scripts/grant-platform-role.ts --email owner@example.com --role platform_owner --reason "initial bootstrap"
 *   pnpm exec tsx scripts/grant-platform-role.ts --phone +9665XXXXXXXX --role support_admin
 *   pnpm exec tsx scripts/grant-platform-role.ts --email x@example.com --role support_admin --revoke
 *
 * Uses DATABASE_OWNER_URL (from the environment or .env).
 */
import pg from 'pg';
import { loadDotEnv } from './load-env';
import { bootstrapPlatformRole, BOOTSTRAP_ROLES, type BootstrapRole } from '../src/server/domains/platform/bootstrap';

function arg(name: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  loadDotEnv();
  const url = process.env.DATABASE_OWNER_URL;
  if (!url) throw new Error('DATABASE_OWNER_URL is required');
  const role = arg('role') as BootstrapRole | undefined;
  if (!role || !BOOTSTRAP_ROLES.includes(role)) throw new Error(`--role must be one of: ${BOOTSTRAP_ROLES.join(', ')}`);
  const client = new pg.Client({ connectionString: url, application_name: 'luma-grant-platform-role' });
  await client.connect();
  try {
    const r = await bootstrapPlatformRole(client, { email: arg('email'), phone: arg('phone'), role, revoke: process.argv.includes('--revoke'), reason: arg('reason') });
    console.log(`${r.changed ? 'OK' : 'No change'}: ${r.action} ${r.role} for ${r.displayName} (${r.userId})`);
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(`[grant-platform-role] ${(e as Error).message}`);
  process.exit(1);
});
