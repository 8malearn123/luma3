import { platformRoute } from '@/server/domains/platform/guard';
import { requireUuidParam } from '@/server/http/params';
import { dismissEscalation } from '@/server/domains/policy/platform';
import { escalationDismiss } from '@/shared/schemas/policy';

export const POST = platformRoute({
  platformCapability: 'platform.policy.review', stepUp: true, input: escalationDismiss,
  handler: async ({ user, actor, params, input }) => ({ data: await dismissEscalation(user, actor, requireUuidParam(params, 'id'), input) }),
});
