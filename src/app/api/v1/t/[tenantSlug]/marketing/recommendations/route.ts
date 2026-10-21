import { z } from 'zod';
import { route } from '@/server/http/route';
import { listRecommendations } from '@/server/domains/marketing/recommendations';


export const GET = route({
  auth: 'tenant', capability: ['marketing.view', 'marketing.manage'], feature: 'feature.marketing_ai',
  input: z.object({ status: z.enum(['open', 'accepted', 'dismissed', 'deferred', 'expired', 'superseded']).optional() }).strict(),
  handler: async ({ tenant, input }) => ({ data: await listRecommendations(tenant, input.status) }),
});
