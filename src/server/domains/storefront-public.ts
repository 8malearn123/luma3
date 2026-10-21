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
