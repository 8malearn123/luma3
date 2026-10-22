import { z } from 'zod';
import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { diffVersions } from '@/server/domains/marketing/plans';


export const GET = route({
  auth: 'tenant', capability: ['marketing.view', 'marketing.manage'], feature: 'feature.marketing_ai',
  input: z.object({ from: z.coerce.number().int().min(1), to: z.coerce.number().int().min(1) }).strict(),
  handler: async ({ tenant, params, input }) => ({ data: await diffVersions(tenant, requireUuidParam(params, 'id'), input.from, input.to) }),
});
