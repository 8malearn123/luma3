import { z } from 'zod';
import { route } from '@/server/http/route';
import { createLocation, listLocations } from '@/server/domains/commerce/locations';
import { locationInput } from '@/shared/schemas/inventory';

/** Stock locations (main warehouse, branch stores, chair stations, custody, quarantine). */
export const GET = route({
  auth: 'tenant', capability: ['inventory.view', 'inventory.manage', 'purchasing.view'], feature: 'feature.inventory',
  input: z.object({ include_inactive: z.enum(['0', '1']).optional() }),
  handler: async ({ tenant, input }) => ({ data: await listLocations(tenant, { includeInactive: input.include_inactive === '1' }) }),
});

/** New location within the plan's limit.stock_locations (branch defaults do not count). */
export const POST = route({
  auth: 'tenant', capability: 'inventory.manage', feature: 'feature.inventory', input: locationInput,
  handler: async ({ tenant, actor, input }) => ({ status: 201, data: await createLocation(tenant, actor, input) }),
});
