import { route } from '@/server/http/route';
import { confirmBookingPolicy } from '@/server/domains/settings/service';
import { policyConfirmInput } from '@/shared/schemas/settings';

/** POST /api/v1/t/:slug/settings/booking-policy/confirm — "I have reviewed the booking & payment policy" (readiness item). */
export const POST = route({
  auth: 'tenant', capability: 'business.manage', input: policyConfirmInput,
  handler: async ({ tenant, actor, input }) => ({ data: await confirmBookingPolicy(tenant, actor, input) }),
});
