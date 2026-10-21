import { platformRoute } from '@/server/domains/platform/guard';
import { revokeSupportGrant } from '@/server/domains/platform/support';
import { requireUuidParam } from '@/server/http/params';
import { supportRevokeInput } from '@/shared/schemas/platform';

/** POST /api/v1/platform/support-grants/:id/revoke — end access early (holder or platform owner). */
export const POST = platformRoute({
  platformCapability: 'platform.support.access', input: supportRevokeInput,
  handler: async ({ params, user, actor, input }) => ({ data: await revokeSupportGrant(user, actor, requireUuidParam(params, 'id'), input.reason) }),
});
