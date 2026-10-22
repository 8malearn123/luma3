import { route } from '@/server/http/route';
import { listReviews } from '@/server/domains/reviews/service';
import { reviewListQuery } from '@/shared/schemas/customers';

export const GET = route({
  auth: 'tenant', capability: 'customers.view', input: reviewListQuery,
  handler: async ({ tenant, input }) => ({ data: await listReviews(tenant, input) }),
});
