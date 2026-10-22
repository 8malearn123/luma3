import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { updatePlatformRule } from '@/server/domains/policy/platform';
import { rulePatch } from '@/shared/schemas/policy';

export const PATCH = route({
  auth: 'platform', platformCapability: 'platform.policy.review', stepUp: true, input: rulePatch,
  handler: async ({ actor, params, input }) => ({ data: await updatePlatformRule(actor, requireUuidParam(params, 'id'), input) }),
});
