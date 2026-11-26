import { route } from '@/server/http/route';
import { hostSummary } from '@/server/domains/hosting/reports';

/** Hosting revenue, receivables and settlements (journal basis). */
export const GET = route({ auth: 'tenant', capability: ['hosting.view', 'hosting.manage', 'finance.view'], feature: 'hosting.reports', handler: async ({ tenant }) => ({ data: await hostSummary(tenant) }) });
