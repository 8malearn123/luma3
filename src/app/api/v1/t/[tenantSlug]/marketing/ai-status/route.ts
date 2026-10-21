import { route } from '@/server/http/route';
import { marketingAiStatus } from '@/server/domains/marketing/service';


export const GET = route({
  auth: 'tenant', capability: ['marketing.view', 'marketing.manage'], feature: 'feature.marketing_ai',
  handler: async ({ tenant }) => ({ data: await marketingAiStatus(tenant) }),
});
