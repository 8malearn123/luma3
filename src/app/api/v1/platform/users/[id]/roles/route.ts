import { platformRoute } from '@/server/domains/platform/guard';
import { changePlatformRole } from '@/server/domains/platform/users';
import { requireUuidParam } from '@/server/http/params';
import { roleChangeInput } from '@/shared/schemas/platform';

/** POST /api/v1/platform/users/:id/roles — grant/revoke an admin role (platform owner + step-up, audited). */
export const POST = platformRoute({
  platformCapability: 'platform.roles.manage', stepUp: true, input: roleChangeInput,
  handler: async ({ params, actor, user, input }) => ({ data: await changePlatformRole({ ...actor, userId: user.userId }, requireUuidParam(params, 'id'), input) }),
});
