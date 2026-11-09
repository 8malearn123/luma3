import { route } from '@/server/http/route';
import { loomApi, preferencesInput } from '@/loom';
import { LOOM_FEATURE, LOOM_MANAGE, loomCtx } from '@/server/loom-host/access';

/** PUT /loom/preferences — budget, discount policy, excluded/growth offerings, tone, ranking weights (explicit facts). */
export const PUT = route({
  auth: 'tenant', capability: LOOM_MANAGE, feature: LOOM_FEATURE, input: preferencesInput,
  handler: async ({ tenant, actor, locale, input }) => ({ data: await loomApi.putPreferences(loomCtx(tenant, actor, locale), input) }),
});
