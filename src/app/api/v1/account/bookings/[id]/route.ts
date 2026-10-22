import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { customerBookingDetail } from '@/server/domains/booking/customer';

/** GET the customer's own booking: snapshot items/terms, payments, receipts, allowed actions and refund preview. */
export const GET = route({ auth: 'user', handler: async ({ user, params }) => ({ data: await customerBookingDetail(user.userId, requireUuidParam(params, 'id')) }) });
