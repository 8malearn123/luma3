import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { updateSource } from '@/server/domains/marketing/trends';
import { trendSourcePatch } from '@/shared/schemas/marketing';


export const PATCH = route({
  auth: 'tenant', capability: 'marketing.manage', feature: 'feature.marketing_ai', input: trendSourcePatch,
  handler: async ({ tenant, actor, params, input }) => ({ data: await updateSource(tenant, actor, requireUuidParam(params, 'id'), input.status) }),
});
