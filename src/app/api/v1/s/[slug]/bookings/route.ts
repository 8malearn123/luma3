import { route } from '@/server/http/route';
import { createHold } from '@/server/domains/booking/service';
import { publicTenant } from '@/server/domains/storefront-public';
import { holdInput } from '@/shared/schemas/booking';
import { toItem } from '../availability/route';
import { attachConversionSession, sessionFromRequest } from '@/server/domains/analytics/events';

/** POST /api/v1/s/{slug}/bookings — hold the chosen itinerary for the signed-in, verified customer. */
export const POST = route({
  auth: 'user',
  requireVerified: true,
  idempotency: 'required',
  input: holdInput,
  rateLimit: { scope: 'user', name: 'public_hold', limit: 30, windowSec: 600 },
  handler: async ({ req, params, input, user, actor, idempotencyKey }) => {
    const t = await publicTenant(params.slug!);
    const r = await createHold(t.id, {
      branchId: input.branch_id, items: input.items.map((i) => ({ ...toItem(i), staffId: i.staff_id, start: i.start })),
      customer: { kind: 'user', user }, source: 'storefront', audience: 'public', customerNote: input.customer_note ?? null,
      idempotencyKey: idempotencyKey!, actor: { ...actor, kind: 'customer' },
    });
    if (r.status === 201) await attachConversionSession(t.id, 'bookings', (r.body as { booking_id: string }).booking_id, sessionFromRequest(req));
    return { status: r.status, data: r.body };
  },
});
