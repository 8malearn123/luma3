import { sql } from 'kysely';
import type { z } from 'zod';
import { db, withTenant, type Tx } from '../../db/client';
import { env } from '../../env';
import { Errors } from '../../http/errors';
import { audit, type AuditActor } from '../../infra/audit';
import { sendTransactional } from '../../infra/messaging';
import { notifyCapability } from '../../infra/notify';
import { canAssignRole, invalidGrants, type TenantRole } from '../../auth/capabilities';
import { hashToken, newToken } from '../../auth/crypto';
import type { SessionUser } from '../../auth/service';
import { requireWithinLimit, type TenantAccess } from '../../tenancy/access';
import { assertTenantAssets } from '../assets/service';
import { parseIdentifier } from '@/shared/phone';
import type { inviteInput, membershipPatch, ownProfilePatch, staffInput, staffPatch } from '@/shared/schemas/team';

// ── Staff profiles (separate from login identity) ───────────────────────────
export async function listStaff(access: TenantAccess, opts: { includeArchived?: boolean } = {}) {
  return withTenant(access.tenantId, async (trx) => {
    let q = trx.selectFrom('staff_profiles').selectAll();
    if (!opts.includeArchived) q = q.where('archived_at', 'is', null);
    const staff = await q.orderBy('sort').orderBy('created_at').execute();
    if (!staff.length) return [];
    const ids = staff.map((s) => s.id);
    const [branches, services, members] = await Promise.all([
      trx.selectFrom('staff_branch_assignments').selectAll().where('staff_id', 'in', ids).execute(),
      trx.selectFrom('service_staff').select(['staff_id', 'service_id']).where('staff_id', 'in', ids).execute(),
      trx.selectFrom('tenant_memberships').select(['staff_profile_id', 'role', 'status', 'user_id']).where('staff_profile_id', 'in', ids).where('status', '=', 'active').execute(),
    ]);
    return staff.map((s) => ({
      ...s,
      branch_ids: branches.filter((b) => b.staff_id === s.id).map((b) => b.branch_id),
      service_ids: services.filter((x) => x.staff_id === s.id).map((x) => x.service_id),
      has_login: members.some((m) => m.staff_profile_id === s.id),
    }));
  });
}

async function setStaffLinks(trx: Tx, tenantId: string, staffId: string, input: { branch_ids?: string[]; service_ids?: string[] }) {
  if (input.branch_ids) {
    await trx.deleteFrom('staff_branch_assignments').where('staff_id', '=', staffId).execute();
    if (input.branch_ids.length) await trx.insertInto('staff_branch_assignments').values(input.branch_ids.map((b) => ({ tenant_id: tenantId, staff_id: staffId, branch_id: b }))).execute();
  }
  if (input.service_ids) {
    await trx.deleteFrom('service_staff').where('staff_id', '=', staffId).where('service_id', 'not in', input.service_ids.length ? input.service_ids : ['00000000-0000-0000-0000-000000000000']).execute();
    const existing = await trx.selectFrom('service_staff').select('service_id').where('staff_id', '=', staffId).execute();
    const have = new Set(existing.map((e) => e.service_id));
    const add = input.service_ids.filter((s) => !have.has(s));
    if (add.length) await trx.insertInto('service_staff').values(add.map((s) => ({ tenant_id: tenantId, service_id: s, staff_id: staffId }))).execute();
  }
}

export async function createStaff(access: TenantAccess, actor: AuditActor, input: z.infer<typeof staffInput>) {
  return withTenant(access.tenantId, async (trx) => {
    const count = await trx.selectFrom('staff_profiles').select(sql<number>`count(*)::int`.as('n')).where('archived_at', 'is', null).where('is_active', '=', true).executeTakeFirstOrThrow();
    requireWithinLimit(access, 'limit.staff', count.n);
    if (input.photo_asset_id) await assertTenantAssets(trx, access.tenantId, [input.photo_asset_id]);
    const { branch_ids, service_ids, ...fields } = input;
    const max = await trx.selectFrom('staff_profiles').select(sql<number>`coalesce(max(sort), -1)::int`.as('m')).executeTakeFirstOrThrow();
    const s = await trx.insertInto('staff_profiles').values({ tenant_id: access.tenantId, ...fields, sort: max.m + 1 }).returning('id').executeTakeFirstOrThrow();
    let branches = branch_ids;
    if (!branches?.length) {
      const primary = await trx.selectFrom('branches').select('id').where('is_primary', '=', true).executeTakeFirst();
      branches = primary ? [primary.id] : [];
    }
    await setStaffLinks(trx, access.tenantId, s.id, { branch_ids: branches, service_ids });
    await audit(trx, actor, 'staff.created', { tenantId: access.tenantId, targetType: 'staff', targetId: s.id });
    return s;
  });
}

/**
 * Updating or deactivating staff preserves historical bookings. Deactivating
 * someone with future appointments alerts management to reassign them.
 */
export async function updateStaff(access: TenantAccess, actor: AuditActor, staffId: string, patch: z.infer<typeof staffPatch>) {
  return withTenant(access.tenantId, async (trx) => {
    const cur = await trx.selectFrom('staff_profiles').selectAll().where('id', '=', staffId).forUpdate().executeTakeFirst();
    if (!cur) throw Errors.notFound('staff');
    if (patch.photo_asset_id) await assertTenantAssets(trx, access.tenantId, [patch.photo_asset_id]);
    const { branch_ids, service_ids, ...fields } = patch;
    if (fields.is_active === true && !cur.is_active) {
      const count = await trx.selectFrom('staff_profiles').select(sql<number>`count(*)::int`.as('n')).where('archived_at', 'is', null).where('is_active', '=', true).executeTakeFirstOrThrow();
      requireWithinLimit(access, 'limit.staff', count.n);
    }
    if (Object.keys(fields).length) await trx.updateTable('staff_profiles').set(fields).where('id', '=', staffId).execute();
    await setStaffLinks(trx, access.tenantId, staffId, { branch_ids, service_ids });
    let affected: string[] = [];
    if (fields.is_active === false && cur.is_active) {
      affected = await futureBookingsFor(trx, staffId);
      if (affected.length) {
        await notifyCapability(trx, access.tenantId, ['bookings.manage', 'schedule.manage'], {
          kind: 'staff.deactivated_with_bookings',
          title_ar: `${cur.display_name}: ${affected.length} مواعيد قادمة تحتاج إجراء`,
          title_en: `${cur.display_name}: ${affected.length} upcoming appointments need action`,
          target_path: `/app/${access.slug}/bookings?staff=${staffId}&upcoming=1`,
          data: { staff_id: staffId, booking_ids: affected },
        });
      }
    }
    await audit(trx, actor, 'staff.updated', { tenantId: access.tenantId, targetType: 'staff', targetId: staffId, data: { fields: Object.keys(fields), affected_bookings: affected.length } });
    return { id: staffId, affected_booking_ids: affected };
  });
}

export async function futureBookingsFor(trx: Tx, staffId: string, during?: { from: Date; to: Date }) {
  let q = trx.selectFrom('booking_items as i').innerJoin('bookings as b', 'b.id', 'i.booking_id').select('b.id').distinct()
    .where('i.staff_id', '=', staffId).where('b.status', 'in', ['held', 'pending_approval', 'pending_payment', 'confirmed']);
  if (during) q = q.where('i.starts_at', '<', during.to).where('i.ends_at', '>', during.from);
  else q = q.where('i.starts_at', '>', new Date());
  return (await q.execute()).map((r) => r.id);
}

/** The caller's own linked staff profile (public-facing fields only), for the staff portal. */
export async function getOwnProfile(access: TenantAccess) {
  if (!access.staffProfileId) throw Errors.notFound('staff');
  return withTenant(access.tenantId, async (trx) => {
    const p = await trx.selectFrom('staff_profiles')
      .select(['id', 'display_name', 'display_name_en', 'title_ar', 'title_en', 'bio_ar', 'bio_en', 'photo_asset_id', 'is_active', 'is_public'])
      .where('id', '=', access.staffProfileId!).executeTakeFirst();
    if (!p) throw Errors.notFound('staff');
    return p;
  });
}

/** A specialist edits only allowlisted fields of her own linked profile. */
export async function updateOwnProfile(access: TenantAccess, actor: AuditActor, patch: z.infer<typeof ownProfilePatch>) {
  if (!access.staffProfileId) throw Errors.forbidden('Your account is not linked to a staff profile');
  return withTenant(access.tenantId, async (trx) => {
    if (patch.photo_asset_id) await assertTenantAssets(trx, access.tenantId, [patch.photo_asset_id]);
    await trx.updateTable('staff_profiles').set(patch).where('id', '=', access.staffProfileId!).execute();
    await audit(trx, actor, 'staff.own_profile_updated', { tenantId: access.tenantId, targetType: 'staff', targetId: access.staffProfileId, data: { fields: Object.keys(patch) } });
    return { id: access.staffProfileId };
  });
}

// ── Memberships ─────────────────────────────────────────────────────────────
export async function listMembers(access: TenantAccess) {
  return withTenant(access.tenantId, async (trx) => {
    const rows = await trx.selectFrom('tenant_memberships').selectAll().where('status', '<>', 'removed').orderBy('created_at').execute();
    const users = rows.length ? await db().selectFrom('users').select(['id', 'display_name', 'email', 'phone']).where('id', 'in', rows.map((r) => r.user_id)).execute() : [];
    const invites = await trx.selectFrom('invitations').select(['id', 'email', 'phone', 'role', 'expires_at', 'accepted_at', 'revoked_at', 'created_at'])
      .where('accepted_at', 'is', null).where('revoked_at', 'is', null).where('expires_at', '>', new Date()).execute();
    return {
      members: rows.map((m) => ({ ...m, user: users.find((u) => u.id === m.user_id) ?? null })),
      pending_invitations: invites,
    };
  });
}

export async function invite(access: TenantAccess, actor: AuditActor, input: z.infer<typeof inviteInput>) {
  const actorCaps = access.capabilities;
  if (access.role === 'support' || !canAssignRole(access.role, actorCaps, input.role)) throw Errors.forbidden('You cannot invite this role');
  const bad = invalidGrants(input.role, input.granted_capabilities);
  if (bad.length) throw Errors.invalid('capability_not_delegable', 'Some capabilities cannot be granted to this role', { capabilities: bad });
  const id = parseIdentifier(input.identifier);
  if (!id) throw Errors.invalid('invalid_identifier');
  const token = newToken();
  const inv = await withTenant(access.tenantId, async (trx) => {
    if (input.staff_profile_id) {
      const sp = await trx.selectFrom('staff_profiles').select('id').where('id', '=', input.staff_profile_id).executeTakeFirst();
      if (!sp) throw Errors.notFound('staff');
    }
    const r = await trx.insertInto('invitations').values({
      tenant_id: access.tenantId, email: id.kind === 'email' ? id.value : null, phone: id.kind === 'phone' ? id.value : null,
      role: input.role, granted_capabilities: input.granted_capabilities, staff_profile_id: input.staff_profile_id ?? null,
      token_hash: hashToken(token, 'invite'), invited_by: actor.userId!, expires_at: new Date(Date.now() + input.expires_in_days * 86_400_000),
    }).returning(['id', 'expires_at']).executeTakeFirstOrThrow();
    await audit(trx, actor, 'team.invited', { tenantId: access.tenantId, targetType: 'invitation', targetId: r.id, data: { role: input.role, capabilities: input.granted_capabilities } });
    return r;
  });
  const link = `${env().APP_URL}/invite/${token}`;
  const delivery = await sendTransactional({
    channel: id.kind === 'email' ? 'email' : 'sms', to: id.value, templateKey: 'team.invite', tenantId: access.tenantId,
    subject: `${access.name} — LUMA`,
    body: `دعوة للانضمام إلى ${access.name} على لوما: ${link}`,
  });
  return {
    id: inv.id, expires_at: inv.expires_at, delivery: delivery.status,
    // Development only (labelled): lets testers open the invite without a mail provider.
    ...(delivery.status === 'simulated' && env().devOtpEcho ? { dev_invite_link: link } : {}),
  };
}

export async function revokeInvitation(access: TenantAccess, actor: AuditActor, invitationId: string) {
  return withTenant(access.tenantId, async (trx) => {
    const r = await trx.updateTable('invitations').set({ revoked_at: new Date() }).where('id', '=', invitationId).where('accepted_at', 'is', null).returning('id').executeTakeFirst();
    if (!r) throw Errors.notFound('invitation');
    await audit(trx, actor, 'team.invitation_revoked', { tenantId: access.tenantId, targetType: 'invitation', targetId: invitationId });
    return r;
  });
}

/** Accepts an invitation for the signed-in user, whose verified contact must match it. */
export async function acceptInvitation(user: SessionUser, token: string, actor: AuditActor) {
  const rows = await sql<{ id: string; tenant_id: string; email: string | null; phone: string | null; role: TenantRole; granted_capabilities: string[];
    staff_profile_id: string | null; expires_at: Date; accepted_at: Date | null; revoked_at: Date | null }>`
    select * from app.invitation_by_token(${hashToken(token, 'invite')})`.execute(db());
  const inv = rows.rows[0];
  if (!inv || inv.revoked_at || inv.accepted_at || inv.expires_at < new Date()) throw Errors.invalid('invitation_invalid', 'This invitation is invalid or has expired');
  const matches = (inv.email && user.emailVerified && user.email?.toLowerCase() === inv.email.toLowerCase())
    || (inv.phone && user.phoneVerified && user.phone === inv.phone);
  if (!matches) throw Errors.forbidden('Sign in with the verified email or phone this invitation was sent to', { reason: 'identity_mismatch' });

  return withTenant(inv.tenant_id, async (trx) => {
    const locked = await trx.selectFrom('invitations').select(['accepted_at']).where('id', '=', inv.id).forUpdate().executeTakeFirstOrThrow();
    if (locked.accepted_at) throw Errors.invalid('invitation_invalid');
    const existing = await trx.selectFrom('tenant_memberships').select(['id', 'status']).where('user_id', '=', user.userId).executeTakeFirst();
    if (existing && existing.status === 'active') throw Errors.conflict('already_member', 'You are already a member of this business');
    if (existing) {
      await trx.updateTable('tenant_memberships').set({ role: inv.role, granted_capabilities: inv.granted_capabilities, revoked_capabilities: [], status: 'active', staff_profile_id: inv.staff_profile_id })
        .where('id', '=', existing.id).execute();
    } else {
      await trx.insertInto('tenant_memberships').values({
        tenant_id: inv.tenant_id, user_id: user.userId, role: inv.role, granted_capabilities: inv.granted_capabilities,
        staff_profile_id: inv.staff_profile_id, created_by: user.userId,
      }).execute();
    }
    await trx.updateTable('invitations').set({ accepted_at: new Date(), accepted_by: user.userId }).where('id', '=', inv.id).execute();
    await audit(trx, actor, 'team.invitation_accepted', { tenantId: inv.tenant_id, targetType: 'invitation', targetId: inv.id, data: { role: inv.role } });
    const t = await trx.selectFrom('tenants').select(['slug']).where('id', '=', inv.tenant_id).executeTakeFirstOrThrow();
    return { tenant_slug: t.slug, role: inv.role };
  });
}

/**
 * Role/capability changes. Owners can change anyone but themselves into
 * non-owner roles; delegated managers cannot touch managers or owners. Nobody
 * can grant platform powers or ownership here.
 */
export async function updateMembership(access: TenantAccess, actor: AuditActor, membershipId: string, patch: z.infer<typeof membershipPatch>) {
  if (access.role === 'support') throw Errors.forbidden();
  return withTenant(access.tenantId, async (trx) => {
    const m = await trx.selectFrom('tenant_memberships').selectAll().where('id', '=', membershipId).forUpdate().executeTakeFirst();
    if (!m) throw Errors.notFound('member');
    if (m.role === 'owner') throw Errors.forbidden('The owner membership cannot be changed here');
    if (m.user_id === actor.userId) throw Errors.forbidden('You cannot change your own role');
    if (!canAssignRole(access.role as TenantRole, access.capabilities, m.role as TenantRole)) throw Errors.forbidden();
    const newRole = (patch.role ?? m.role) as TenantRole;
    if (!canAssignRole(access.role as TenantRole, access.capabilities, newRole)) throw Errors.forbidden('You cannot assign this role');
    if (patch.granted_capabilities) {
      const bad = invalidGrants(newRole, patch.granted_capabilities);
      if (bad.length) throw Errors.invalid('capability_not_delegable', 'Some capabilities cannot be granted to this role', { capabilities: bad });
    }
    if (patch.staff_profile_id) {
      const sp = await trx.selectFrom('staff_profiles').select('id').where('id', '=', patch.staff_profile_id).executeTakeFirst();
      if (!sp) throw Errors.notFound('staff');
    }
    await trx.updateTable('tenant_memberships').set({
      role: newRole,
      ...(patch.granted_capabilities ? { granted_capabilities: patch.granted_capabilities } : {}),
      ...(patch.revoked_capabilities ? { revoked_capabilities: patch.revoked_capabilities } : {}),
      ...(patch.status ? { status: patch.status } : {}),
      ...(patch.staff_profile_id !== undefined ? { staff_profile_id: patch.staff_profile_id } : {}),
    }).where('id', '=', membershipId).execute();
    await audit(trx, actor, 'team.membership_updated', { tenantId: access.tenantId, targetType: 'membership', targetId: membershipId, data: { from_role: m.role, ...patch } });
    return { id: membershipId, role: newRole };
  });
}
