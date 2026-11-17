import { platformRoute } from '@/server/domains/platform/guard';
import { requireUuidParam } from '@/server/http/params';
import { resolvePlatformAppeal } from '@/server/domains/policy/platform';
import { appealResolve } from '@/shared/schemas/policy';

export const POST = platformRoute({
  platformCapability: 'platform.policy.review', stepUp: true, input: appealResolve,
  handler: async ({ user, actor, params, input }) => ({ data: await resolvePlatformAppeal(user, actor, requireUuidParam(params, 'id'), input) }),
});
