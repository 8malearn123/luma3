import { route } from '@/server/http/route';
import { trendCards } from '@/server/domains/marketing/trends';


export const GET = route({
  auth: 'tenant', capability: ['marketing.view', 'marketing.manage'], feature: 'feature.marketing_ai',
  handler: async ({ tenant }) => ({ data: await trendCards(tenant) }),
});
