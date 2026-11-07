import { platformRoute } from '@/server/domains/platform/guard';
import { setCommissionRate } from '@/server/domains/marketplace/listing';
import { requireUuidParam } from '@/server/http/params';
import { commissionInput } from '@/shared/schemas/marketplace';

/** PUT { commission_bp | null } — LUMA commission rate for this business's marketplace bookings (null = platform default). */
export const PUT = platformRoute({
  platformCapability: 'platform.marketplace.manage', stepUp: true, input: commissionInput,
  handler: async ({ params, actor, input }) => ({ data: await setCommissionRate(requireUuidParam(params, 'tenantId'), actor, input.commission_bp) }),
});
