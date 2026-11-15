import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { getCount, saveCountLines } from '@/server/domains/commerce/counts';
import { stockCountLinesInput } from '@/shared/schemas/commerce';

export const GET = route({
  auth: 'tenant', capability: ['inventory.view', 'inventory.manage'], feature: 'feature.inventory_counts',
  handler: async ({ tenant, params }) => ({ data: await getCount(tenant, requireUuidParam(params, 'id')) }),
});

/** Saves counted quantities on a draft (optimistic concurrency on version). */
export const PATCH = route({
  auth: 'tenant', capability: ['inventory.manage', 'inventory.count'], feature: 'feature.inventory_counts', input: stockCountLinesInput,
  handler: async ({ tenant, actor, input, params }) => ({ data: await saveCountLines(tenant, actor, requireUuidParam(params, 'id'), input) }),
});
