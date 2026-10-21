import { z } from 'zod';
import { route } from '@/server/http/route';
import { createResourceType } from '@/server/domains/catalog/service';

export const POST = route({
  auth: 'tenant', capability: 'catalog.edit', feature: 'feature.resources',
  input: z.object({ name_ar: z.string().trim().max(80).optional(), name_en: z.string().trim().max(80).optional() }).refine((v) => v.name_ar || v.name_en, 'A name is required'),
  handler: async ({ tenant, actor, input }) => ({ status: 201, data: await createResourceType(tenant, actor, input) }),
});
