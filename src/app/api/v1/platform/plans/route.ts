import { platformRoute } from '@/server/domains/platform/guard';
import { listPlans } from '@/server/domains/platform/plans';

/** GET /api/v1/platform/plans — plans with the full feature matrix. */
export const GET = platformRoute({
  platformCapability: 'platform.tenants.view',
  handler: async () => ({ data: await listPlans() }),
});
