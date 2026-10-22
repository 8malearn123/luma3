import { sql } from 'kysely';
import { db } from './client';
import { env } from '../env';
import { AppError } from '../http/errors';

export type RoleCheck = { role: string; safe: boolean; reason: string | null };

let cached: Promise<RoleCheck> | null = null;

/**
 * Row-level security only applies when the app connects as a role that neither
 * owns the tables nor bypasses RLS. Hosting integrations often inject an owner
 * connection string, which would silently disable tenant isolation.
 */
export function checkRuntimeRole(): Promise<RoleCheck> {
  cached ??= sql<{ role: string; owns: boolean | null; bypass: boolean }>`
    select current_user as role,
      (select c.relowner = r.oid from pg_class c where c.oid = to_regclass('public.tenants')) as owns,
      (r.rolsuper or r.rolbypassrls) as bypass
    from pg_roles r where r.rolname = current_user`.execute(db())
    .then(({ rows }) => {
      const r = rows[0]!;
      const reason = r.bypass ? 'role bypasses RLS (superuser or BYPASSRLS)' : r.owns ? 'role owns the tables, so RLS does not apply' : null;
      return { role: r.role, safe: !reason, reason };
    })
    .catch((e) => { cached = null; throw e; });
  return cached;
}

/** In deployed modes (review/production), refuse to serve with an RLS-bypassing database role. */
export async function requireSafeRuntimeRole() {
  if (!env().isDeployed) return;
  const c = await checkRuntimeRole();
  if (!c.safe) {
    console.error(`[db] unsafe runtime role "${c.role}": ${c.reason}. Set LUMA_DATABASE_URL to the luma_app connection string.`);
    throw new AppError(503, 'unsafe_database_role', 'The server is misconfigured: it must connect with the non-owner application role.');
  }
}

/** Test helper: forget the cached check after switching connections. */
export function resetRoleCheck() {
  cached = null;
}
