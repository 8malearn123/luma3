import { route } from '@/server/http/route';
import { goalsInput, loomApi } from '@/loom';
import { LOOM_FEATURE, LOOM_MANAGE, loomCtx } from '@/server/loom-host/access';

/** PUT /loom/goals — replaces the active goals and confirms the "goals" setup item. */
export const PUT = route({
  auth: 'tenant', capability: LOOM_MANAGE, feature: LOOM_FEATURE, input: goalsInput,
  handler: async ({ tenant, actor, locale, input }) => ({ data: await loomApi.putGoals(loomCtx(tenant, actor, locale), input) }),
});
