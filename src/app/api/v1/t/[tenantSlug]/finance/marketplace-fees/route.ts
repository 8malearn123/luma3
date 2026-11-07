import { route } from '@/server/http/route';
import { marketplaceFeesFor } from '@/server/domains/marketplace/attribution';
import { feePeriodQuery } from '@/shared/schemas/marketplace';

/** GET ?from&to — «عمولة سوق لوما»: LUMA commission lines on this business's marketplace bookings. */
export const GET = route({
  auth: 'tenant', capability: 'finance.view', input: feePeriodQuery,
  handler: async ({ tenant, input }) => ({ data: await marketplaceFeesFor(tenant.tenantId, input) }),
});
