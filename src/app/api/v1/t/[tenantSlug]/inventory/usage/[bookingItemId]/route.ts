import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { planUsage } from '@/server/domains/commerce/consumption';
import { usagePlanInput } from '@/shared/schemas/inventory';

/** Planned actual usage for a visit before completion (posted once at completion). */
export const PUT = route({
  auth: 'tenant', capability: ['inventory.adjust_usage', 'inventory.manage'], feature: 'feature.inventory', input: usagePlanInput,
  handler: async ({ tenant, actor, input, params }) => ({ data: await planUsage(tenant, actor, requireUuidParam(params, 'bookingItemId'), input) }),
});
