import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { correctUsage } from '@/server/domains/commerce/consumption';
import { actualUsageInput } from '@/shared/schemas/inventory';

/** Corrects the actual quantity used (posts only the difference). */
export const PATCH = route({
  auth: 'tenant', capability: ['inventory.adjust_usage', 'inventory.manage'], feature: 'feature.inventory', input: actualUsageInput,
  handler: async ({ tenant, actor, input, params }) => ({ data: await correctUsage(tenant, actor, requireUuidParam(params, 'id'), input) }),
});
