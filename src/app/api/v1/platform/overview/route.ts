import { platformRoute, platformCaps } from '@/server/domains/platform/guard';
import { platformOverview } from '@/server/domains/platform/reports';

/** GET /api/v1/platform/overview — dashboard counts; sections depend on the caller's platform capabilities. */
export const GET = platformRoute({
  handler: async ({ user }) => ({ data: await platformOverview(platformCaps(user)) }),
});
