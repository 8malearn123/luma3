import { z } from 'zod';
import { route } from '@/server/http/route';
import { listConsumptions } from '@/server/domains/commerce/consumption';

/** Material consumption records (expected vs actual per visit, manual issues). */
export const GET = route({
  auth: 'tenant', capability: ['inventory.view', 'inventory.manage', 'inventory.adjust_usage'], feature: 'feature.inventory',
  input: z.object({ booking_item_id: z.string().uuid().optional(), status: z.enum(['pending', 'posted', 'shortage', 'cancelled']).optional() }),
  handler: async ({ tenant, input }) => ({ data: await listConsumptions(tenant, input) }),
});
