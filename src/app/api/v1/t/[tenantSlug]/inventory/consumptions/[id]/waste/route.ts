import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { recordConsumptionWaste } from '@/server/domains/commerce/consumption';
import { consumptionWasteInput } from '@/shared/schemas/inventory';

/** Waste during a service: its own movement with a reason (posts shrinkage). */
export const POST = route({
  auth: 'tenant', capability: ['inventory.adjust_usage', 'inventory.manage'], feature: 'feature.inventory', input: consumptionWasteInput,
  handler: async ({ tenant, actor, input, params }) => ({ status: 201, data: await recordConsumptionWaste(tenant, actor, requireUuidParam(params, 'id'), input.quantity, input.reason) }),
});
