import { route } from '@/server/http/route';
import { getReviewRequestSettings, updateReviewRequestSettings } from '@/server/domains/reviews/requests';
import { reviewRequestSettingsInput } from '@/shared/schemas/customer-experience';

/** GET/PUT /api/v1/t/:slug/settings/review-requests — when to ask customers for a review after the visit. */
export const GET = route({
  auth: 'tenant', capability: 'business.manage',
  handler: async ({ tenant }) => ({ data: await getReviewRequestSettings(tenant) }),
});

export const PUT = route({
  auth: 'tenant', capability: 'business.manage', input: reviewRequestSettingsInput,
  handler: async ({ tenant, actor, input }) => ({ data: await updateReviewRequestSettings(tenant, actor, input) }),
});
