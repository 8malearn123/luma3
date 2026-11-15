import { z } from 'zod';
import { route } from '@/server/http/route';
import { quoteSpace } from '@/server/domains/hosting/search';

/** Base chair price vs total with add-ons, before paying. */
export const POST = route({
  auth: 'tenant', capability: 'workspace.book', feature: 'workspace.book',
  input: z.object({ listing_id: z.string().uuid(), duration_min: z.number().int().min(15).max(1440), addons: z.array(z.object({ addon_id: z.string().uuid(), quantity: z.number().int().min(1).max(50) }).strict()).max(20).default([]) }).strict(),
  handler: async ({ tenant, input }) => ({ data: await quoteSpace(tenant, input) }),
});
