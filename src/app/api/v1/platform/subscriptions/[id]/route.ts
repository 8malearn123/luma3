import { platformRoute } from '@/server/domains/platform/guard';
import { platformSubscriptionDetail } from '@/server/domains/subscriptions/service';
import { requireUuidParam } from '@/server/http/params';

/** GET /api/v1/platform/subscriptions/:id — subscription, events (append-only history), test invoices, usage. */
export const GET = platformRoute({
  platformCapability: 'platform.tenants.view',
  handler: async ({ params }) => ({ data: await platformSubscriptionDetail(requireUuidParam(params, 'id')) }),
});
