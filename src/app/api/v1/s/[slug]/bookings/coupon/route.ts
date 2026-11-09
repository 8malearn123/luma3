import { route } from '@/server/http/route';
import { publicTenant } from '@/server/domains/storefront-public';
import { previewBookingCoupon } from '@/server/domains/booking/coupon-preview';
import { bookingCouponPreviewInput } from '@/shared/schemas/booking';
import { toItem } from '../../availability/route';

/** POST /api/v1/s/{slug}/bookings/coupon — preview a coupon on the chosen itinerary (nothing is redeemed). */
export const POST = route({
  auth: 'optional',
  input: bookingCouponPreviewInput,
  rateLimit: { scope: 'ip', name: 'booking_coupon_preview', limit: 30, windowSec: 600 },
  handler: async ({ params, input, user }) => {
    const t = await publicTenant(params.slug!);
    return { data: await previewBookingCoupon(t.id, { branchId: input.branch_id, code: input.code, items: input.items.map((i) => ({ ...toItem(i), staffId: i.staff_id })), userId: user?.userId ?? null }) };
  },
});
