import { db, sql, withSystem, type Tx } from '../db/client';
import {
  effectiveCapabilities, platformCapabilities, supportCapabilities,
  type Capability, type PlatformCapability, type TenantRole,
} from '../auth/capabilities';
import type { SessionUser } from '../auth/service';
import { Errors } from '../http/errors';
import type { PlanFeatureKey, PlanLimitKey } from '@/shared/plans';

export type PlanEntitlements = {
  planCode: string | null;
  subscriptionStatus: string | null;
  features: Map<string, { enabled: boolean; limit: number | null }>;
};

export type TenantAccess = {
  tenantId: string;
  slug: string;
  name: string;
  status: string;
  businessType: string;
  timezone: string;
  currency: string;
  defaultLocale: 'ar' | 'en';
  role: TenantRole | 'support';
  membershipId: string | null;
  staffProfileId: string | null;
  capabilities: Set<Capability>;
  supportGrantId: string | null;
  plan: PlanEntitlements;
  /** Expired/cancelled subscriptions keep data readable but block new writes. */
  readOnly: boolean;
};

export async function loadEntitlements(trx: Tx | ReturnType<typeof db>, tenantId: string): Promise<PlanEntitlements & { readOnly: boolean }> {
  const sub = await trx.selectFrom('subscriptions as s').innerJoin('plans as p', 'p.id', 's.plan_id')
    .select(['s.status', 's.grace_until', 's.plan_id', 'p.code'])
    .where('s.tenant_id', '=', tenantId)
    .orderBy(sql`case when s.status in ('trialing','active','past_due','paused') then 0 else 1 end`)
    .orderBy('s.created_at', 'desc')
    .executeTakeFirst();
  const features = new Map<string, { enabled: boolean; limit: number | null }>();
  if (sub) {
    const rows = await trx.selectFrom('plan_features').selectAll().where('plan_id', '=', sub.plan_id).execute();
    for (const r of rows) features.set(r.feature_key, { enabled: r.enabled, limit: r.limit_value });
  }
  const lapsed = !sub || sub.status === 'expired' || sub.status === 'cancelled'
    || (sub.status === 'past_due' && sub.grace_until !== null && sub.grace_until < new Date());
  return { planCode: sub?.code ?? null, subscriptionStatus: sub?.status ?? null, features, readOnly: lapsed };
}

/**
 * Resolves the caller's access to a tenant from their *own* membership (or an
 * active, time-limited support grant). Unknown slugs and tenants the caller is
 * not a member of both produce 404, so tenant existence is not disclosed.
 */
export async function resolveTenantAccess(user: SessionUser, slug: string): Promise<TenantAccess> {
  if (!/^[a-z0-9-]{3,48}$/.test(slug)) throw Errors.notFound('business');
  const memberships = await sql<{
    membership_id: string; tenant_id: string; tenant_slug: string; tenant_name: string; tenant_status: string; role: TenantRole;
    granted_capabilities: string[]; revoked_capabilities: string[]; staff_profile_id: string | null; business_type: string;
  }>`select * from app.memberships_for_user(${user.userId})`.execute(db());
  const m = memberships.rows.find((r) => r.tenant_slug === slug);

  const base = await sql<{ id: string; slug: string; name: string; status: string; default_locale: 'ar' | 'en'; timezone: string; currency: string; business_type: string }>`
    select id, slug, name, status, default_locale, timezone, currency, business_type from app.resolve_tenant_slug(${slug})`.execute(db());
  const tenant = base.rows[0];
  if (!tenant) throw Errors.notFound('business');

  if (m) {
    const ent = await withSystem('load plan entitlements for member', (trx) => loadEntitlements(trx, tenant.id));
    return {
      tenantId: tenant.id, slug: tenant.slug, name: tenant.name, status: tenant.status, businessType: tenant.business_type,
      timezone: tenant.timezone, currency: tenant.currency, defaultLocale: tenant.default_locale,
      role: m.role, membershipId: m.membership_id, staffProfileId: m.staff_profile_id,
      capabilities: m.tenant_status === 'suspended' ? new Set() : effectiveCapabilities(m.role, m.granted_capabilities, m.revoked_capabilities),
      supportGrantId: null, plan: ent, readOnly: ent.readOnly || tenant.status === 'suspended',
    };
  }

  // LUMA support: only with an active, reasoned, time-limited grant.
  const pcaps = platformCapabilities(user.platformRoles);
  if (pcaps.has('platform.support.access')) {
    const grant = await withSystem('check support grant', (trx) => trx.selectFrom('support_access_grants').select(['id', 'access_level'])
      .where('tenant_id', '=', tenant.id).where('platform_user_id', '=', user.userId).where('revoked_at', 'is', null)
      .where('starts_at', '<=', new Date()).where('expires_at', '>', new Date())
      .orderBy('expires_at', 'desc').executeTakeFirst());
    if (grant) {
      const ent = await withSystem('load plan entitlements for support', (trx) => loadEntitlements(trx, tenant.id));
      return {
        tenantId: tenant.id, slug: tenant.slug, name: tenant.name, status: tenant.status, businessType: tenant.business_type,
        timezone: tenant.timezone, currency: tenant.currency, defaultLocale: tenant.default_locale,
        role: 'support', membershipId: null, staffProfileId: null,
        capabilities: supportCapabilities(grant.access_level as 'read' | 'write'),
        supportGrantId: grant.id, plan: ent, readOnly: grant.access_level === 'read',
      };
    }
  }
  throw Errors.notFound('business');
}

export function hasCapability(access: TenantAccess, cap: Capability | readonly Capability[]) {
  const list = Array.isArray(cap) ? cap : [cap as Capability];
  return list.some((c) => access.capabilities.has(c));
}

export function requireCapability(access: TenantAccess, cap: Capability | readonly Capability[]) {
  if (!hasCapability(access, cap)) throw Errors.forbidden(undefined, { required: cap });
}

export function featureEnabled(access: Pick<TenantAccess, 'plan'>, key: PlanFeatureKey) {
  const f = access.plan.features.get(key);
  return !!f?.enabled;
}

export function requireFeature(access: Pick<TenantAccess, 'plan'>, key: PlanFeatureKey) {
  if (!featureEnabled(access, key)) throw Errors.planFeature(key);
}

/** Server-side plan limit check; call inside the creating transaction. */
export function requireWithinLimit(access: Pick<TenantAccess, 'plan'>, key: PlanLimitKey, currentCount: number) {
  const f = access.plan.features.get(key);
  if (!f || !f.enabled) throw Errors.planLimit(key, 0);
  if (f.limit !== null && currentCount >= f.limit) throw Errors.planLimit(key, f.limit);
}

export function requireWritable(access: TenantAccess) {
  if (access.readOnly) throw Errors.forbidden('This workspace is read-only (subscription inactive or read-only support access)', { reason: 'read_only' });
}

export function requirePlatform(user: SessionUser, cap: PlatformCapability) {
  if (!platformCapabilities(user.platformRoles).has(cap)) throw Errors.notFound();
}
