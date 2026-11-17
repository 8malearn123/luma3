import { platformRoute } from '@/server/domains/platform/guard';
import { createPlatformDecision, listPlatformDecisions } from '@/server/domains/policy/platform';
import { decisionListQuery, platformDecisionCreate } from '@/shared/schemas/policy';

export const GET = platformRoute({
  platformCapability: 'platform.policy.review', input: decisionListQuery,
  handler: async ({ input }) => ({ data: await listPlatformDecisions(input) }),
});

/** POST — platform-scope decision (policy_reviewer/platform_owner + step-up; suspension: platform_owner only). */
export const POST = platformRoute({
  platformCapability: 'platform.policy.review', stepUp: true, input: platformDecisionCreate, idempotency: 'optional',
  handler: async ({ user, actor, input }) => ({ status: 201, data: await createPlatformDecision(user, actor, input) }),
});
