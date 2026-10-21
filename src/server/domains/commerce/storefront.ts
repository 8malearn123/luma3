import { db, sql } from '../../db/client';
import { Errors } from '../../http/errors';

export type StorefrontTenant = { tenantId: string; slug: string; name: string; currency: string; timezone: string; defaultLocale: 'ar' | 'en' };

/**
 * Resolves a public storefront by slug (SECURITY DEFINER lookup, allowlisted
 * columns). Only live businesses sell: status 'active', or a published site
 * while not suspended/closed. Everything else is the same 404.
 */
export async function resolveStorefront(slug: string): Promise<StorefrontTenant> {
  if (!/^[a-z0-9-]{3,48}$/.test(slug)) throw Errors.notFound('business');
  const r = await sql<{ id: string; slug: string; name: string; status: string; currency: string; timezone: string; default_locale: 'ar' | 'en'; published_version_id: string | null }>`
    select id, slug, name, status, currency, timezone, default_locale, published_version_id from app.resolve_tenant_slug(${slug})`.execute(db());
  const t = r.rows[0];
  if (!t) throw Errors.notFound('business');
  const live = t.status === 'active' || (t.published_version_id !== null && t.status !== 'suspended' && t.status !== 'closed');
  if (!live) throw Errors.notFound('business');
  return { tenantId: t.id, slug: t.slug, name: t.name, currency: t.currency, timezone: t.timezone, defaultLocale: t.default_locale };
}
