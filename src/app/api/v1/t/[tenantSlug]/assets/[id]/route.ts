import { z } from 'zod';
import { route } from '@/server/http/route';
import { deleteAsset, updateAlt } from '@/server/domains/assets/service';
import { requireUuidParam } from '@/server/http/params';

export const PATCH = route({
  auth: 'tenant', capability: ['builder.edit', 'catalog.edit'],
  input: z.object({ alt_ar: z.string().max(160).nullable().optional(), alt_en: z.string().max(160).nullable().optional() }),
  handler: async ({ tenant, params, input }) => ({ data: await updateAlt(tenant, requireUuidParam(params, 'id'), input) }),
});
export const DELETE = route({
  auth: 'tenant', capability: ['builder.edit', 'catalog.edit'],
  handler: async ({ tenant, actor, params }) => ({ data: await deleteAsset(tenant, actor, requireUuidParam(params, 'id')) }),
});
