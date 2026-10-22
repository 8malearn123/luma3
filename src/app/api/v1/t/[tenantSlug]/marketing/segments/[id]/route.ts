import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { updateSegment } from '@/server/domains/marketing/segments';
import { segmentInput } from '@/shared/schemas/marketing';


export const PATCH = route({
  auth: 'tenant', capability: 'marketing.manage', feature: 'feature.campaigns', input: segmentInput,
  handler: async ({ tenant, actor, params, input }) => ({ data: await updateSegment(tenant, actor, requireUuidParam(params, 'id'), input) }),
});
