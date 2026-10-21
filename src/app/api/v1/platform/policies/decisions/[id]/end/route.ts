import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { endPlatformDecision } from '@/server/domains/policy/platform';
import { decisionEnd } from '@/shared/schemas/policy';

export const POST = route({
  auth: 'platform', platformCapability: 'platform.policy.review', stepUp: true, input: decisionEnd,
  handler: async ({ user, actor, params, input }) => ({ data: await endPlatformDecision(user, actor, requireUuidParam(params, 'id'), input) }),
});
