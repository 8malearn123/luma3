export * from './rules';
export * from './directory';
export * from './listing';
export * from './attribution';

import { withTenant } from '../../db/client';
import { resolvePublishedTenant } from '../storefront/service';

/** Storefront badge: verified by LUMA (tenant scope resolved from the published slug). */
export async function storefrontBadge(slug: string) {
  const t = await resolvePublishedTenant(slug);
  if (!t) return { verified: false };
  return withTenant(t.id, async (trx) => {
    const v = await trx.selectFrom('tenant_verifications').select('status').where('tenant_id', '=', t.id).executeTakeFirst();
    return { verified: v?.status === 'verified' };
  });
}
