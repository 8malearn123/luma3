import type pg from 'pg';

/**
 * Bootstrap for LUMA administrative roles, used by scripts/grant-platform-role.ts
 * with the migration-owner connection (DATABASE_OWNER_URL). This is the ONLY way
 * to create the first platform_owner; afterwards platform owners manage roles in
 * /platform/users (step-up + audit). Every change is audited with actor_kind
 * 'system'. Kept free of app env/Next imports so the CLI runs standalone.
 */
export const BOOTSTRAP_ROLES = ['platform_owner', 'support_admin', 'policy_reviewer', 'technical_admin'] as const;
export type BootstrapRole = (typeof BOOTSTRAP_ROLES)[number];

export type BootstrapInput = { email?: string; phone?: string; role: BootstrapRole; revoke?: boolean; reason?: string };

export async function bootstrapPlatformRole(client: pg.ClientBase, input: BootstrapInput) {
  if (!BOOTSTRAP_ROLES.includes(input.role)) throw new Error(`Unknown role "${input.role}". Use one of: ${BOOTSTRAP_ROLES.join(', ')}`);
  if (!input.email && !input.phone) throw new Error('Pass --email or --phone of an existing, verified account');
  await client.query('begin');
  try {
    const u = await client.query<{ id: string; display_name: string; status: string; verified: boolean }>(
      input.email
        ? `select id, display_name, status, (email_verified_at is not null or phone_verified_at is not null) as verified from users where email = $1::citext`
        : `select id, display_name, status, (email_verified_at is not null or phone_verified_at is not null) as verified from users where phone = $1`,
      [input.email ?? input.phone]);
    const user = u.rows[0];
    if (!user) throw new Error('No account with that email/phone. The person must register and verify first.');
    if (user.status !== 'active') throw new Error('The account is not active');
    let changed = false;
    if (input.revoke) {
      if (input.role === 'platform_owner') {
        const owners = await client.query<{ n: number }>(`select count(*)::int as n from platform_roles where role = 'platform_owner' and revoked_at is null and user_id <> $1`, [user.id]);
        if ((owners.rows[0]?.n ?? 0) === 0) throw new Error('Refusing to revoke the last platform_owner');
      }
      const r = await client.query(`update platform_roles set revoked_at = now() where user_id = $1 and role = $2 and revoked_at is null`, [user.id, input.role]);
      changed = (r.rowCount ?? 0) > 0;
    } else {
      if (!user.verified) throw new Error('The account must have a verified email or phone');
      const r = await client.query(`insert into platform_roles (user_id, role) values ($1, $2) on conflict (user_id, role) where revoked_at is null do nothing`, [user.id, input.role]);
      changed = (r.rowCount ?? 0) > 0;
    }
    if (changed) {
      await client.query(
        `insert into audit_logs (tenant_id, actor_user_id, actor_kind, action, target_type, target_id, data) values (null, null, 'system', $1, 'user', $2, $3)`,
        [input.revoke ? 'platform.role.revoked' : 'platform.role.granted', user.id, JSON.stringify({ role: input.role, via: 'cli', reason: input.reason ?? null })]);
    }
    await client.query('commit');
    return { userId: user.id, displayName: user.display_name, role: input.role, action: input.revoke ? 'revoke' : 'grant', changed };
  } catch (e) {
    await client.query('rollback');
    throw e;
  }
}
