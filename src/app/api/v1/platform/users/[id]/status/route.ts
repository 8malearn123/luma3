import { platformRoute } from '@/server/domains/platform/guard';
import { setUserStatus } from '@/server/domains/platform/users';
import { requireUuidParam } from '@/server/http/params';
import { userStatusInput } from '@/shared/schemas/platform';

/** POST /api/v1/platform/users/:id/status — suspend / reactivate a central account (step-up, audited). */
export const POST = platformRoute({
  platformCapability: 'platform.users.manage', stepUp: true, input: userStatusInput,
  handler: async ({ params, actor, user, input }) => ({ data: await setUserStatus({ ...actor, userId: user.userId }, requireUuidParam(params, 'id'), input) }),
});
