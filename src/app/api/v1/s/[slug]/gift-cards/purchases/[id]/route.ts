import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { publicTenant } from '@/server/domains/storefront-public';
import { giftPurchaseStatus } from '@/server/domains/giftcards/online';

/** GET the buyer's view of an online gift card purchase (payment, card and delivery status; never the code). */
export const GET = route({
  auth: 'user',
  handler: async ({ params, user }) => {
    const t = await publicTenant(params.slug!);
    return { data: await giftPurchaseStatus(t.id, user.userId, requireUuidParam(params, 'id')) };
  },
});
