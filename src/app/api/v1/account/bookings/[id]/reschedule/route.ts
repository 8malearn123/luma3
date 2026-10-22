import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { reschedule } from '@/server/domains/booking/service';
import { customerBookingTenant } from '@/server/domains/booking/customer';
import { rescheduleInput } from '@/shared/schemas/booking';
import { toItem } from '@/app/api/v1/s/[slug]/availability/route';

export const POST = route({
  auth: 'user', input: rescheduleInput,
  handler: async ({ user, params, input, actor }) => {
    const id = requireUuidParam(params, 'id');
    const ref = await customerBookingTenant(user.userId, id);
    return { data: await reschedule(ref.tenant_id, id, { kind: 'customer', userId: user.userId, audit: { ...actor, kind: 'customer' } }, { items: input.items.map((i) => ({ ...toItem(i), staffId: i.staff_id, start: i.start })), acceptTotalMinor: input.accept_total_minor }) };
  },
});
