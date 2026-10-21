import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { rewardPatch, updateReward } from '@/server/domains/loyalty/service';

/** PATCH edit or (de)activate a reward. Rewards are never deleted. */
export const PATCH = route({
  auth: 'tenant', capability: 'loyalty.manage', feature: 'feature.loyalty', input: rewardPatch,
  handler: async ({ tenant, actor, params, input }) => ({ data: await updateReward(tenant, actor, requireUuidParam(params, 'id'), input) }),
});
