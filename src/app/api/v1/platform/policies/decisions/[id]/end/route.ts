import { platformRoute } from '@/server/domains/platform/guard';
import { requireUuidParam } from '@/server/http/params';
import { endPlatformDecision } from '@/server/domains/policy/platform';
import { decisionEnd } from '@/shared/schemas/policy';

export const POST = platformRoute({
  platformCapability: 'platform.policy.review', stepUp: true, input: decisionEnd,
  handler: async ({ user, actor, params, input }) => ({ data: await endPlatformDecision(user, actor, requireUuidParam(params, 'id'), input) }),
});
