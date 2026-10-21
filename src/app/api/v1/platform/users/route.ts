import { platformRoute } from '@/server/domains/platform/guard';
import { listUsers } from '@/server/domains/platform/users';
import { userListQuery } from '@/shared/schemas/platform';

/** GET /api/v1/platform/users — central accounts and their admin roles. */
export const GET = platformRoute({
  platformCapability: 'platform.users.manage', input: userListQuery,
  handler: async ({ input }) => ({ data: await listUsers(input) }),
});
