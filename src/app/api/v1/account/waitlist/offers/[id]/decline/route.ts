import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { declineOffer } from '@/server/domains/waitlist/service';

export const POST = route({ auth: 'user', handler: async ({ params, user }) => ({ data: await declineOffer(user, requireUuidParam(params, 'id')) }) });
