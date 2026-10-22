import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { getOfferForCustomer } from '@/server/domains/waitlist/service';

/** GET the signed-in customer's own waitlist offer (slot, specialist, expiry). */
export const GET = route({ auth: 'user', handler: async ({ params, user }) => ({ data: await getOfferForCustomer(user, requireUuidParam(params, 'id')) }) });
