import { route } from '@/server/http/route';
import { createReward, rewardInput } from '@/server/domains/loyalty/service';

export const POST = route({ auth: 'tenant', capability: 'loyalty.manage', feature: 'feature.loyalty', input: rewardInput, handler: async ({ tenant, actor, input }) => ({ status: 201, data: await createReward(tenant, actor, input) }) });
