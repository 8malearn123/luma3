import { sql } from 'kysely';
import { db } from '../db/client';
import { Errors } from '../http/errors';

export type PublicTenant = { id: string; slug: string; name: string; status: string; timezone: string; currency: string; default_locale: 'ar' | 'en'; published_version_id: string | null; business_type: string };

/** Resolves a storefront slug for public transactional APIs (booking, cart, checkout). Unpublished or inactive → 404. */
export async function publicTenant(slug: string): Promise<PublicTenant> {
  if (!/^[a-z0-9-]{3,48}$/.test(slug)) throw Errors.notFound('business');
  const r = await sql<PublicTenant>`select * from app.resolve_tenant_slug(${slug})`.execute(db());
  const t = r.rows[0];
  if (!t || t.status !== 'active') throw Errors.notFound('business');
  return t;
}

import { withSystem } from '../db/client';
import { loadEntitlements } from '../tenancy/access';

/**
 * R4 / LUMA-AUDIT-012: whether the storefront may take NEW bookings, orders
 * and purchases. The same rule that makes the dashboard read-only applies:
 * the subscription is active/trialing, or past_due still inside its grace
 * window (grace_until). After that the store stays visible with a notice;
 * existing bookings, orders and their payments are untouched.
 */
export async function storefrontSelling(tenantId: string): Promise<boolean> {
  const ent = await withSystem('storefront: subscription check', (trx) => loadEntitlements(trx, tenantId));
  return !ent.readOnly;
}

export async function requireStorefrontSelling(tenantId: string) {
  if (!(await storefrontSelling(tenantId))) {
    throw Errors.conflict('storefront_unavailable', 'This business is not taking new bookings or orders right now');
  }
}

/** publicTenant() for endpoints that create a new booking, order or purchase. */
export async function publicTenantForSale(slug: string): Promise<PublicTenant> {
  const t = await publicTenant(slug);
  await requireStorefrontSelling(t.id);
  return t;
}

/** For storefront pages: false (show the notice) when the subscription lapsed beyond its grace window. */
export async function storefrontSellingBySlug(slug: string): Promise<boolean> {
  try {
    return await storefrontSelling((await publicTenant(slug)).id);
  } catch {
    return true; // unknown/unpublished stores are handled (404) by the page itself
  }
}
import type { PlanFeatureKey } from '@/shared/plans';

/** Plan features are enforced on public endpoints too, not only hidden in menus. */
export async function requirePublicFeature(tenantId: string, key: PlanFeatureKey) {
  const ent = await withSystem('public feature check', (trx) => loadEntitlements(trx, tenantId));
  if (ent.readOnly || !ent.features.get(key)?.enabled) throw Errors.notFound();
}
