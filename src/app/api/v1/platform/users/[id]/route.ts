import { platformRoute } from '@/server/domains/platform/guard';
import { userDetail } from '@/server/domains/platform/users';
import { requireUuidParam } from '@/server/http/params';

/** GET /api/v1/platform/users/:id */
export const GET = platformRoute({
  platformCapability: 'platform.users.manage',
  handler: async ({ params }) => ({ data: await userDetail(requireUuidParam(params, 'id')) }),
});
