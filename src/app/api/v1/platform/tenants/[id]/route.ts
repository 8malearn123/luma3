import { platformRoute } from '@/server/domains/platform/guard';
import { tenantDetail } from '@/server/domains/platform/tenants';
import { requireUuidParam } from '@/server/http/params';

/** GET /api/v1/platform/tenants/:id — aggregates only (no customer records). */
export const GET = platformRoute({
  platformCapability: 'platform.tenants.view',
  handler: async ({ params }) => ({ data: await tenantDetail(requireUuidParam(params, 'id')) }),
});
