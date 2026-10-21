import { route } from '@/server/http/route';
import { searchAvailability } from '@/server/domains/booking/service';
import { publicTenant } from '@/server/domains/storefront-public';
import { availabilityInput } from '@/shared/schemas/booking';

/** POST (read-only search) /api/v1/s/{slug}/availability — feasible itineraries only; no appointment details. */
export const POST = route({
  auth: 'optional',
  input: availabilityInput,
  rateLimit: { scope: 'ip', name: 'public_availability', limit: 120, windowSec: 60 },
  handler: async ({ params, input }) => {
    const t = await publicTenant(params.slug!);
    return { data: await searchAvailability(t.id, { branchId: input.branch_id, items: input.items.map(toItem), from: input.from, to: input.to, audience: 'public' }) };
  },
});

export function toItem(i: { key: string; service_id: string; variant_id?: string | null; addon_ids?: string[]; staff_id?: string | null }) {
  return { key: i.key, serviceId: i.service_id, variantId: i.variant_id ?? null, addonIds: i.addon_ids ?? [], staffId: i.staff_id ?? null };
}
