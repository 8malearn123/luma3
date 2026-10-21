import { route } from '@/server/http/route';
import { getPerfSettings, savePerfSettings } from '@/server/domains/analytics/performance';
import { performanceSettingsInput } from '@/shared/schemas/marketing';

export const GET = route({
  auth: 'tenant', capability: 'analytics.view',
  handler: async ({ tenant }) => ({ data: await getPerfSettings(tenant) }),
});

export const PUT = route({
  auth: 'tenant', capability: ['business.manage', 'team.manage'], input: performanceSettingsInput,
  handler: async ({ tenant, actor, input }) => ({ data: await savePerfSettings(tenant, actor, input) }),
});
