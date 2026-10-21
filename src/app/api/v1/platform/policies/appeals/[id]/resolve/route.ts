import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { resolvePlatformAppeal } from '@/server/domains/policy/platform';
import { appealResolve } from '@/shared/schemas/policy';

export const POST = route({
  auth: 'platform', platformCapability: 'platform.policy.review', stepUp: true, input: appealResolve,
  handler: async ({ user, actor, params, input }) => ({ data: await resolvePlatformAppeal(user, actor, requireUuidParam(params, 'id'), input) }),
});
