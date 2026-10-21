import { z } from 'zod';
import { route } from '@/server/http/route';
import { updateResource } from '@/server/domains/catalog/service';
import { requireUuidParam } from '@/server/http/params';

export const PATCH = route({
  auth: 'tenant', capability: 'catalog.edit', input: z.object({ name: z.string().trim().min(1).max(80).optional(), is_active: z.boolean().optional() }),
  handler: async ({ tenant, input, params }) => ({ data: await updateResource(tenant, requireUuidParam(params, 'id'), input) }),
});
