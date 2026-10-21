import { z } from 'zod';
import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { transition } from '@/server/domains/booking/service';
import { customerBookingTenant } from '@/server/domains/booking/customer';

/** POST — the customer cancels her own booking; terms captured at booking time decide any refund. */
export const POST = route({
  auth: 'user', input: z.object({ reason: z.string().trim().min(3).max(500) }),
  handler: async ({ user, params, input, actor }) => {
    const id = requireUuidParam(params, 'id');
    const ref = await customerBookingTenant(user.userId, id);
    return { data: await transition(ref.tenant_id, id, 'cancel', { kind: 'customer', userId: user.userId, audit: { ...actor, kind: 'customer' } }, { reason: input.reason }) };
  },
});
