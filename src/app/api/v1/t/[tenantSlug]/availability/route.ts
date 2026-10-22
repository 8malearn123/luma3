import { route } from '@/server/http/route';
import { searchAvailability } from '@/server/domains/booking/service';
import { availabilityInput } from '@/shared/schemas/booking';
import { toItem } from '@/app/api/v1/s/[slug]/availability/route';

/** Internal availability (includes hidden-but-internally-bookable services and non-public staff). */
export const POST = route({
  auth: 'tenant', capability: ['bookings.manage', 'bookings.view_all'], input: availabilityInput,
  handler: async ({ tenant, input }) => ({ data: await searchAvailability(tenant.tenantId, { branchId: input.branch_id, items: input.items.map(toItem), from: input.from, to: input.to, audience: 'internal' }) }),
});
