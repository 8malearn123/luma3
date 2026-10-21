import { sql } from 'kysely';
import { withSystem } from '../../db/client';
import { Errors } from '../../http/errors';
import { audit, type AuditActor } from '../../infra/audit';
import { notifyUsers } from '../../infra/notify';
import { platformCapabilities, PLATFORM_ROLES, type PlatformRole } from '../../auth/capabilities';

/**
 * Central LUMA accounts and administrative roles. Platform roles are granted
 * or revoked ONLY here (platform_owner + step-up, audited) or by the bootstrap
 * CLI (scripts/grant-platform-role.ts). Registration, tenant APIs and the
 * browser can never create them.
 */
export async function listUsers(q: { q?: string; platform_only?: '0' | '1'; page: number; limit: number }) {
  return withSystem('platform: list central accounts', async (trx) => {
    let base = trx.selectFrom('users as u');
    const term = q.q;
    if (term) {
      const digits = term.replace(/[^0-9+]/g, '');
      base = base.where((eb) => eb.or([eb('u.display_name', 'ilike', `%${term}%`), eb(sql<string>`u.email::text`, 'ilike', `%${term}%`), ...(digits.length >= 4 ? [eb('u.phone', 'like', `%${digits}%`)] : [])]));
    }
    if (q.platform_only === '1') base = base.where((eb) => eb.exists(eb.selectFrom('platform_roles as r').select('r.id').whereRef('r.user_id', '=', 'u.id').where('r.revoked_at', 'is', null)));
    const total = await base.select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow();
    const rows = await base.select([
      'u.id', 'u.display_name', 'u.email', 'u.phone', 'u.status', 'u.is_demo', 'u.created_at', 'u.mfa_enabled_at',
      sql<boolean>`(u.email_verified_at is not null or u.phone_verified_at is not null)`.as('verified'),
      sql<string[]>`coalesce((select array_agg(r.role order by r.role) from platform_roles r where r.user_id = u.id and r.revoked_at is null), '{}')`.as('platform_roles'),
      sql<number>`(select count(*)::int from tenant_memberships m where m.user_id = u.id and m.status = 'active')`.as('memberships'),
    ]).orderBy('u.created_at', 'desc').limit(q.limit).offset((q.page - 1) * q.limit).execute();
    return { items: rows, total: total.n, page: q.page, limit: q.limit };
  });
}

export async function userDetail(id: string) {
  return withSystem('platform: central account detail', async (trx) => {
    const u = await trx.selectFrom('users').select(['id', 'display_name', 'email', 'phone', 'status', 'is_demo', 'created_at', 'email_verified_at', 'phone_verified_at', 'mfa_enabled_at', 'locale'])
      .where('id', '=', id).executeTakeFirst();
    if (!u) throw Errors.notFound('user');
    const roles = await trx.selectFrom('platform_roles as r').leftJoin('users as g', 'g.id', 'r.granted_by')
      .select(['r.id', 'r.role', 'r.granted_at', 'r.revoked_at', 'g.display_name as granted_by_name']).where('r.user_id', '=', id).orderBy('r.granted_at', 'desc').execute();
    const memberships = await trx.selectFrom('tenant_memberships as m').innerJoin('tenants as t', 't.id', 'm.tenant_id')
      .select(['t.id as tenant_id', sql<string>`t.slug::text`.as('slug'), 't.name', 'm.role', 'm.status']).where('m.user_id', '=', id).orderBy('t.name').execute();
    return { user: u, roles, memberships };
  });
}

export async function changePlatformRole(actor: AuditActor & { userId: string }, targetUserId: string, input: { role: PlatformRole; action: 'grant' | 'revoke'; reason: string }) {
  if (!PLATFORM_ROLES.includes(input.role)) throw Errors.invalid('invalid_role');
  return withSystem('platform: change administrative role', async (trx) => {
    // One role change at a time platform-wide so the "last owner" rule cannot race.
    await sql`select pg_advisory_xact_lock(hashtext('platform_roles'))`.execute(trx);
    const target = await trx.selectFrom('users').select(['id', 'status', 'email_verified_at', 'phone_verified_at', 'is_demo']).where('id', '=', targetUserId).executeTakeFirst();
    if (!target) throw Errors.notFound('user');
    if (input.action === 'grant') {
      if (target.status !== 'active') throw Errors.invalid('user_not_active', 'The account is not active');
      if (!target.email_verified_at && !target.phone_verified_at) throw Errors.invalid('user_not_verified', 'The account must have a verified email or phone');
      const exists = await trx.selectFrom('platform_roles').select('id').where('user_id', '=', targetUserId).where('role', '=', input.role).where('revoked_at', 'is', null).executeTakeFirst();
      if (exists) throw Errors.conflict('role_already_granted', 'The account already has this role');
      await trx.insertInto('platform_roles').values({ user_id: targetUserId, role: input.role, granted_by: actor.userId }).execute();
    } else {
      const row = await trx.selectFrom('platform_roles').select('id').where('user_id', '=', targetUserId).where('role', '=', input.role).where('revoked_at', 'is', null).executeTakeFirst();
      if (!row) throw Errors.conflict('role_not_granted', 'The account does not have this role');
      if (input.role === 'platform_owner') {
        const owners = await trx.selectFrom('platform_roles').select(sql<number>`count(*)::int`.as('n')).where('role', '=', 'platform_owner').where('revoked_at', 'is', null).executeTakeFirstOrThrow();
        if (owners.n <= 1) throw Errors.conflict('last_platform_owner', 'At least one platform owner must remain');
      }
      await trx.updateTable('platform_roles').set({ revoked_at: new Date(), revoked_by: actor.userId }).where('id', '=', row.id).execute();
      const remaining = await trx.selectFrom('platform_roles').select('role').where('user_id', '=', targetUserId).where('revoked_at', 'is', null).execute();
      if (!platformCapabilities(remaining.map((r) => r.role)).has('platform.support.access')) {
        await trx.updateTable('support_access_grants').set({ revoked_at: new Date(), revoked_by: actor.userId, revoke_reason: 'support role revoked' })
          .where('platform_user_id', '=', targetUserId).where('revoked_at', 'is', null).where('expires_at', '>', new Date()).execute();
      }
    }
    await audit(trx, actor, input.action === 'grant' ? 'platform.role.granted' : 'platform.role.revoked', { targetType: 'user', targetId: targetUserId, data: { role: input.role, reason: input.reason } });
    await notifyUsers(trx, null, [targetUserId], {
      kind: 'platform.role_changed',
      title_ar: input.action === 'grant' ? `مُنحتِ دوراً إدارياً في لوما: ${input.role}` : `أُزيل دورك الإداري في لوما: ${input.role}`,
      title_en: input.action === 'grant' ? `You were granted a LUMA admin role: ${input.role}` : `Your LUMA admin role was removed: ${input.role}`,
      target_path: input.action === 'grant' ? '/platform/security' : '/app',
    });
    const roles = await trx.selectFrom('platform_roles').select('role').where('user_id', '=', targetUserId).where('revoked_at', 'is', null).execute();
    return { user_id: targetUserId, roles: roles.map((r) => r.role) };
  });
}

/**
 * Suspends or reactivates a central account (e.g. abuse, compromised account).
 * Suspension signs the person out everywhere and ends their support access;
 * their data and memberships are untouched.
 */
export async function setUserStatus(actor: AuditActor & { userId: string }, targetUserId: string, input: { status: 'active' | 'suspended'; reason: string }) {
  if (targetUserId === actor.userId) throw Errors.invalid('cannot_change_own_status', 'You cannot change the status of your own account');
  return withSystem('platform: change account status', async (trx) => {
    await sql`select pg_advisory_xact_lock(hashtext('platform_roles'))`.execute(trx);
    const u = await trx.selectFrom('users').select(['id', 'status']).where('id', '=', targetUserId).forUpdate().executeTakeFirst();
    if (!u) throw Errors.notFound('user');
    if (u.status === 'deleted') throw Errors.conflict('invalid_transition', 'Deleted accounts cannot be changed');
    if (u.status === input.status) throw Errors.conflict('invalid_transition', 'The account already has this status');
    if (input.status === 'suspended') {
      const isOwner = await trx.selectFrom('platform_roles').select('id').where('user_id', '=', targetUserId).where('role', '=', 'platform_owner').where('revoked_at', 'is', null).executeTakeFirst();
      if (isOwner) {
        const others = await sql<{ n: number }>`select count(*)::int as n from platform_roles r join users x on x.id = r.user_id
          where r.role = 'platform_owner' and r.revoked_at is null and x.status = 'active' and r.user_id <> ${targetUserId}`.execute(trx);
        if ((others.rows[0]?.n ?? 0) === 0) throw Errors.conflict('last_platform_owner', 'At least one active platform owner must remain');
      }
      await trx.updateTable('sessions').set({ revoked_at: new Date(), revoke_reason: 'account_suspended' }).where('user_id', '=', targetUserId).where('revoked_at', 'is', null).execute();
      await trx.updateTable('support_access_grants').set({ revoked_at: new Date(), revoked_by: actor.userId, revoke_reason: 'account suspended' })
        .where('platform_user_id', '=', targetUserId).where('revoked_at', 'is', null).where('expires_at', '>', new Date()).execute();
    }
    await trx.updateTable('users').set({ status: input.status }).where('id', '=', targetUserId).execute();
    await audit(trx, actor, input.status === 'suspended' ? 'platform.user.suspended' : 'platform.user.reactivated', { targetType: 'user', targetId: targetUserId, data: { reason: input.reason } });
    return { id: targetUserId, status: input.status };
  });
}
