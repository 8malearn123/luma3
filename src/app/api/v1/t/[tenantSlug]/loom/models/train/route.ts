import { route } from '@/server/http/route';
import { loomModels } from '@/loom';
import { LOOM_FEATURE, LOOM_MANAGE, loomCtx } from '@/server/loom-host/access';

/** POST /loom/models/train — queues a training run now (job loom.train; below the thresholds it records why and stays baseline). */
export const POST = route({
  auth: 'tenant', capability: LOOM_MANAGE, feature: LOOM_FEATURE,
  handler: async ({ tenant, actor, locale }) => ({ status: 202, data: await loomModels.train(loomCtx(tenant, actor, locale)) }),
});
