import { route } from '@/server/http/route';
import { updateBookingPolicy } from '@/server/domains/settings/service';
import { bookingPolicyInput } from '@/shared/schemas/settings';

/** PUT /api/v1/t/:slug/settings/booking-policy — changing terms clears the review confirmation. */
export const PUT = route({
  auth: 'tenant', capability: 'business.manage', input: bookingPolicyInput,
  handler: async ({ tenant, actor, input }) => ({ data: await updateBookingPolicy(tenant, actor, input) }),
});
