import { route } from '@/server/http/route';
import { createPlatformRule, listPlatformRules } from '@/server/domains/policy/platform';
import { ruleCreate } from '@/shared/schemas/policy';

export const GET = route({
  auth: 'platform', platformCapability: 'platform.policy.review',
  handler: async () => ({ data: await listPlatformRules() }),
});

export const POST = route({
  auth: 'platform', platformCapability: 'platform.policy.review', stepUp: true, input: ruleCreate,
  handler: async ({ actor, input }) => ({ status: 201, data: await createPlatformRule(actor, input) }),
});
