import { route } from '@/server/http/route';
import { getPreferences, savePreferences } from '@/server/domains/marketing/service';
import { preferencesInput } from '@/shared/schemas/marketing';


export const GET = route({
  auth: 'tenant', capability: ['marketing.view', 'marketing.manage'], feature: 'feature.marketing_ai',
  handler: async ({ tenant }) => ({ data: await getPreferences(tenant) }),
});

export const PUT = route({
  auth: 'tenant', capability: 'marketing.manage', feature: 'feature.marketing_ai', input: preferencesInput,
  handler: async ({ tenant, actor, input }) => ({ data: await savePreferences(tenant, actor, input) }),
});
