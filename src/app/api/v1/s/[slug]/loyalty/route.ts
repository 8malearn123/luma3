import { route } from '@/server/http/route';
import { withTenant } from '@/server/db/client';
import { customerLoyalty } from '@/server/domains/loyalty/service';
import { publicTenant, requirePublicFeature } from '@/server/domains/storefront-public';
import { ensureTenantCustomerForUser } from '@/server/domains/customers/relationship';

/** GET the signed-in customer's points at this business (tenant-scoped loyalty). */
export const GET = route({
  auth: 'user',
  handler: async ({ params, user }) => {
    const t = await publicTenant(params.slug!);
    await requirePublicFeature(t.id, 'feature.loyalty');
    const tc = await withTenant(t.id, (trx) => ensureTenantCustomerForUser(trx, t.id, { userId: user.userId, displayName: user.displayName, phone: user.phone, email: user.email }));
    const rewards = await withTenant(t.id, (trx) => trx.selectFrom('rewards').select(['id', 'name_ar', 'name_en', 'points_cost', 'kind', 'value']).where('is_active', '=', true).orderBy('points_cost').execute());
    return { data: { ...(await customerLoyalty(t.id, tc)), rewards } };
  },
});
