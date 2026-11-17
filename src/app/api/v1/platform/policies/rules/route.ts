import { platformRoute } from '@/server/domains/platform/guard';
import { createPlatformRule, listPlatformRules } from '@/server/domains/policy/platform';
import { ruleCreate } from '@/shared/schemas/policy';

export const GET = platformRoute({
  platformCapability: 'platform.policy.review',
  handler: async () => ({ data: await listPlatformRules() }),
});

export const POST = platformRoute({
  platformCapability: 'platform.policy.review', stepUp: true, input: ruleCreate,
  handler: async ({ actor, input }) => ({ status: 201, data: await createPlatformRule(actor, input) }),
});
