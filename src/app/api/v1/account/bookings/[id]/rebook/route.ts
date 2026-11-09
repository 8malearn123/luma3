import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { rebookPrefill } from '@/server/domains/booking/rebook';

/** GET what «إعادة الحجز» prefills: the same services and specialists (still bookable), and the booking page link. */
export const GET = route({ auth: 'user', handler: async ({ user, params }) => ({ data: await rebookPrefill(user.userId, requireUuidParam(params, 'id')) }) });
