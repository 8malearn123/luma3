import { route } from '@/server/http/route';
import { guestSummary } from '@/server/domains/hosting/reports';

/** Hosting expenses and dues (journal basis). */
export const GET = route({ auth: 'tenant', capability: ['workspace.book', 'finance.view'], handler: async ({ tenant }) => ({ data: await guestSummary(tenant) }) });
