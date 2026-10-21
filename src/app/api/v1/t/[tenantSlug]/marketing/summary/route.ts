import { route } from '@/server/http/route';
import { marketingSummary } from '@/server/domains/marketing/service';


export const GET = route({
  auth: 'tenant', capability: ['marketing.view', 'marketing.manage'], feature: 'feature.marketing_ai',
  handler: async ({ tenant }) => ({ data: await marketingSummary(tenant) }),
});
