import { platformRoute } from '@/server/domains/platform/guard';
import { platformBookings } from '@/server/domains/platform/activity';
import { csvResponse } from '@/server/domains/platform/export';
import { activityBookingsQuery } from '@/shared/schemas/admin';

const COLS = ['number', 'tenant_slug', 'tenant_name', 'tenant_city', 'status', 'payment_status', 'source', 'starts_at', 'ends_at', 'items', 'total_minor', 'paid_minor', 'refunded_minor', 'currency', 'created_at'];

/** GET /api/v1/platform/activity/bookings — read-only bookings across businesses (no customer data). */
export const GET = platformRoute({
  platformCapability: 'platform.activity.view', input: activityBookingsQuery,
  handler: async ({ input, actor }) => {
    if (input.format === 'csv') {
      const r = await platformBookings(input, { all: true });
      const { format: _f, page: _p, limit: _l, ...filters } = input;
      return csvResponse(actor, 'activity.bookings', 'luma-bookings.csv', r.items, COLS, filters);
    }
    return { data: await platformBookings(input) };
  },
});
