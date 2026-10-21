import { route } from '@/server/http/route';
import { createSegment, listSegments } from '@/server/domains/marketing/segments';
import { segmentInput } from '@/shared/schemas/marketing';


export const GET = route({
  auth: 'tenant', capability: ['marketing.view', 'marketing.manage', 'campaigns.approve'], feature: 'feature.campaigns',
  handler: async ({ tenant }) => ({ data: await listSegments(tenant) }),
});

export const POST = route({
  auth: 'tenant', capability: 'marketing.manage', feature: 'feature.campaigns', input: segmentInput,
  handler: async ({ tenant, actor, input }) => ({ status: 201, data: await createSegment(tenant, actor, input) }),
});
