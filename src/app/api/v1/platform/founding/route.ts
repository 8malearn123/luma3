import { platformRoute } from '@/server/domains/platform/guard';
import { foundingOverview } from '@/server/domains/platform/pricing';

/** GET /api/v1/platform/founding — founding-customer seats (taken / remaining) and the subscribers holding them. */
export const GET = platformRoute({
  platformCapability: 'platform.tenants.view',
  handler: async () => ({ data: await foundingOverview() }),
});
