import { z } from 'zod';
import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { listingDetail } from '@/server/domains/hosting/search';

export const GET = route({
  auth: 'tenant', capability: 'workspace.book', feature: 'workspace.book',
  input: z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), duration_min: z.coerce.number().int().min(15).max(1440).optional() }),
  handler: async ({ tenant, params, input }) => ({ data: await listingDetail(tenant, requireUuidParam(params, 'id'), input) }),
});
