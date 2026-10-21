import { platformRoute } from '@/server/domains/platform/guard';
import { resetForUser } from '@/server/domains/platform/mfa';
import { requireUuidParam } from '@/server/http/params';
import { mfaResetInput } from '@/shared/schemas/platform';

/** POST /api/v1/platform/users/:id/mfa-reset — recovery for a lost authenticator (platform owner + step-up, audited). */
export const POST = platformRoute({
  platformCapability: 'platform.roles.manage', stepUp: true, input: mfaResetInput,
  handler: async ({ params, actor, user, input }) => ({ data: await resetForUser(user, requireUuidParam(params, 'id'), input.reason, actor) }),
});
