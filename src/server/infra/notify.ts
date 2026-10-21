import type { Tx } from '../db/client';
import { effectiveCapabilities, type Capability, type TenantRole } from '../auth/capabilities';

export type NotificationContent = {
  kind: string;
  title_ar: string;
  title_en: string;
  body_ar?: string;
  body_en?: string;
  /** Internal relative path only. */
  target_path?: string;
  data?: Record<string, unknown>;
  dedupe_key?: string;
};

function safePath(p?: string) {
  return p && /^\/[A-Za-z0-9/_\-?=&.%]*$/.test(p) && !p.startsWith('//') ? p : null;
}

/** In-app notifications for specific users (inside the caller's transaction). */
export async function notifyUsers(trx: Tx, tenantId: string | null, userIds: string[], n: NotificationContent) {
  const unique = [...new Set(userIds)];
  if (!unique.length) return;
  await trx.insertInto('notifications').values(unique.map((userId) => ({
    tenant_id: tenantId, user_id: userId, kind: n.kind, title_ar: n.title_ar, title_en: n.title_en,
    body_ar: n.body_ar ?? null, body_en: n.body_en ?? null, target_path: safePath(n.target_path),
    data: JSON.stringify(n.data ?? {}), dedupe_key: n.dedupe_key ?? null,
  }))).onConflict((oc) => oc.columns(['user_id', 'dedupe_key']).where('dedupe_key', 'is not', null).doNothing()).execute();
}

/** Notifies every active member of the tenant holding any of the capabilities. */
export async function notifyCapability(trx: Tx, tenantId: string, caps: Capability[], n: NotificationContent) {
  const members = await trx.selectFrom('tenant_memberships').select(['user_id', 'role', 'granted_capabilities', 'revoked_capabilities'])
    .where('tenant_id', '=', tenantId).where('status', '=', 'active').execute();
  const targets = members.filter((m) => {
    const eff = effectiveCapabilities(m.role as TenantRole, m.granted_capabilities, m.revoked_capabilities);
    return caps.some((c) => eff.has(c));
  }).map((m) => m.user_id);
  await notifyUsers(trx, tenantId, targets, n);
}

/** Notifies the user account linked to a staff profile, if any. */
export async function notifyStaff(trx: Tx, tenantId: string, staffId: string, n: NotificationContent) {
  const m = await trx.selectFrom('tenant_memberships').select('user_id').where('staff_profile_id', '=', staffId).where('status', '=', 'active').executeTakeFirst();
  if (m) await notifyUsers(trx, tenantId, [m.user_id], n);
}
