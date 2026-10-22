import { route } from '@/server/http/route';
import { previewPlanChange } from '@/server/domains/subscriptions/service';
import { planPreviewQuery } from '@/shared/schemas/settings';

/** GET /api/v1/t/:slug/subscription/preview?plan_code= — direction and overages before changing plan. */
export const GET = route({
  auth: 'tenant', capability: ['subscription.manage', 'subscription.view'], input: planPreviewQuery,
  handler: async ({ tenant, input }) => ({ data: await previewPlanChange(tenant, input.plan_code) }),
});
