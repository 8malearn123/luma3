import { platformRoute } from '@/server/domains/platform/guard';
import { platformListSubscriptions } from '@/server/domains/subscriptions/service';
import { subscriptionListQuery } from '@/shared/schemas/platform';

/** GET /api/v1/platform/subscriptions */
export const GET = platformRoute({
  platformCapability: 'platform.tenants.view', input: subscriptionListQuery,
  handler: async ({ input }) => ({ data: await platformListSubscriptions(input) }),
});
