import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { publicTenant } from '@/server/domains/storefront-public';
import { membershipPurchaseStatus } from '@/server/domains/memberships/online';

/** GET the buyer's own online membership purchase (status, entitlements, payment). */
export const GET = route({
  auth: 'user',
  handler: async ({ params, user }) => {
    const t = await publicTenant(params.slug!);
    return { data: await membershipPurchaseStatus(t.id, user.userId, requireUuidParam(params, 'id')) };
  },
});
