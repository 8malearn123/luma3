import { route } from '@/server/http/route';
import { getSubscriptionOverview } from '@/server/domains/subscriptions/service';

/** GET /api/v1/t/:slug/subscription — plan, status, trial end, usage vs limits, plans, history, test invoices. */
export const GET = route({
  auth: 'tenant', capability: ['subscription.view', 'subscription.manage'],
  handler: async ({ tenant }) => ({ data: await getSubscriptionOverview(tenant) }),
});
