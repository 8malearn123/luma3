import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { reschedule } from '@/server/domains/booking/service';
import { rescheduleInput } from '@/shared/schemas/booking';
import { toItem } from '@/app/api/v1/s/[slug]/availability/route';

export const POST = route({
  auth: 'tenant', capability: 'bookings.manage', input: rescheduleInput,
  handler: async ({ tenant, params, input, actor }) => ({
    data: await reschedule(tenant.tenantId, requireUuidParam(params, 'id'), { kind: 'staff', access: tenant, audit: actor }, {
      items: input.items.map((i) => ({ ...toItem(i), staffId: i.staff_id, start: i.start })), acceptTotalMinor: input.accept_total_minor,
    }),
  }),
});
