import { sql } from 'kysely';
import { withSystem } from '../../db/client';
import { Errors } from '../../http/errors';
import { audit, type AuditActor } from '../../infra/audit';
import { notifyCapability } from '../../infra/notify';
import type { SessionUser } from '../../auth/service';
import { platformCapabilities } from '../../auth/capabilities';

/**
 * Time-limited support access (≤24h, enforced by a DB check), with a recorded
 * reason (≥10 chars). No impersonation: the support user opens /app/{slug} as
 * themselves, sees the support banner, and every action is audited with the
 * grant id. The business owner is notified when access starts and ends.
 */
export async function createSupportGrant(user: SessionUser, actor: AuditActor, input: { tenant_slug: string; reason: string; access_level: 'read' | 'write'; hours: number }) {
  return withSystem('platform: create support access grant', async (trx) => {
    const t = await trx.selectFrom('tenants').select(['id', sql<string>`slug::text`.as('slug'), 'name', 'status']).where('slug', '=', input.tenant_slug).executeTakeFirst();
    if (!t) throw Errors.notFound('business');
    if (t.status === 'closed') throw Errors.conflict('tenant_closed', 'This business is closed');
    const now = new Date();
    const g = await trx.insertInto('support_access_grants').values({
      tenant_id: t.id, platform_user_id: user.userId, reason: input.reason, access_level: input.access_level,
      starts_at: now, expires_at: new Date(now.getTime() + input.hours * 3_600_000), created_by: user.userId,
    }).returningAll().executeTakeFirstOrThrow();
    await audit(trx, { ...actor, supportGrantId: g.id }, 'platform.support.grant_created', { tenantId: t.id, targetType: 'support_grant', targetId: g.id, data: { reason: input.reason, access_level: input.access_level, hours: input.hours } });
    await notifyCapability(trx, t.id, ['business.manage'], {
      kind: 'support.access_started',
      title_ar: `بدأ دعم لوما وصولاً مؤقتاً (${input.access_level === 'write' ? 'قراءة وتعديل' : 'قراءة فقط'}) لمدة ${input.hours} ساعة`,
      title_en: `LUMA support started temporary ${input.access_level === 'write' ? 'read & write' : 'read-only'} access for ${input.hours}h`,
      body_ar: input.reason, body_en: input.reason, target_path: `/app/${t.slug}/audit?support_only=1`,
    });
    return { ...g, tenant_slug: t.slug, tenant_name: t.name, open_path: `/app/${t.slug}` };
  });
}

/** The grant holder can end their own access early; the platform owner can revoke any grant. */
export async function revokeSupportGrant(user: SessionUser, actor: AuditActor, id: string, reason?: string) {
  const isOwner = platformCapabilities(user.platformRoles).has('platform.roles.manage');
  return withSystem('platform: revoke support access grant', async (trx) => {
    const g = await trx.selectFrom('support_access_grants').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
    if (!g || (!isOwner && g.platform_user_id !== user.userId)) throw Errors.notFound('grant');
    if (g.revoked_at) throw Errors.conflict('grant_already_revoked', 'This access was already revoked');
    if (g.expires_at <= new Date()) throw Errors.conflict('grant_expired', 'This access already expired');
    await trx.updateTable('support_access_grants').set({ revoked_at: new Date(), revoked_by: user.userId, revoke_reason: reason ?? null }).where('id', '=', id).execute();
    await audit(trx, { ...actor, supportGrantId: id }, 'platform.support.grant_revoked', { tenantId: g.tenant_id, targetType: 'support_grant', targetId: id, data: { reason: reason ?? null } });
    await notifyCapability(trx, g.tenant_id, ['business.manage'], {
      kind: 'support.access_ended', title_ar: 'انتهى وصول دعم لوما المؤقت إلى نشاطك.', title_en: 'LUMA support access to your business has ended.',
    });
    return { id, revoked: true };
  });
}

export async function listSupportGrants(user: SessionUser, q: { scope: 'active' | 'all'; mine?: '0' | '1' }) {
  const isOwner = platformCapabilities(user.platformRoles).has('platform.roles.manage');
  return withSystem('platform: list support grants', async (trx) => {
    let base = trx.selectFrom('support_access_grants as g').innerJoin('tenants as t', 't.id', 'g.tenant_id').innerJoin('users as u', 'u.id', 'g.platform_user_id')
      .select(['g.id', 'g.reason', 'g.access_level', 'g.starts_at', 'g.expires_at', 'g.revoked_at', 'g.revoke_reason', 'g.created_at', 'g.platform_user_id',
        't.id as tenant_id', sql<string>`t.slug::text`.as('tenant_slug'), 't.name as tenant_name', 'u.display_name as support_user',
        sql<boolean>`(g.revoked_at is null and g.starts_at <= now() and g.expires_at > now())`.as('active')]);
    if (!isOwner || q.mine === '1') base = base.where('g.platform_user_id', '=', user.userId);
    if (q.scope === 'active') base = base.where('g.revoked_at', 'is', null).where('g.expires_at', '>', new Date());
    return base.orderBy('g.created_at', 'desc').limit(200).execute();
  });
}
