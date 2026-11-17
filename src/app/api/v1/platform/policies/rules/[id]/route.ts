import { platformRoute } from '@/server/domains/platform/guard';
import { requireUuidParam } from '@/server/http/params';
import { updatePlatformRule } from '@/server/domains/policy/platform';
import { rulePatch } from '@/shared/schemas/policy';

export const PATCH = platformRoute({
  platformCapability: 'platform.policy.review', stepUp: true, input: rulePatch,
  handler: async ({ actor, params, input }) => ({ data: await updatePlatformRule(actor, requireUuidParam(params, 'id'), input) }),
});
