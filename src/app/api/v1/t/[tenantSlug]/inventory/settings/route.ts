import { route } from '@/server/http/route';
import { readSettings, updateSettings } from '@/server/domains/commerce/locations';
import { inventorySettingsInput } from '@/shared/schemas/inventory';

export const GET = route({
  auth: 'tenant', capability: ['inventory.view', 'inventory.manage'], feature: 'feature.inventory',
  handler: async ({ tenant }) => ({ data: await readSettings(tenant) }),
});

/** D4: transfer confirmation (immediate by default, or confirm receipt). */
export const PUT = route({
  auth: 'tenant', capability: 'business.manage', feature: 'feature.inventory', input: inventorySettingsInput,
  handler: async ({ tenant, actor, input }) => ({ data: await updateSettings(tenant, actor, input) }),
});
