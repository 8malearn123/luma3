import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { moderateReview } from '@/server/domains/reviews/service';
import { reviewModeration } from '@/shared/schemas/customers';

/** POST — hide/flag/restore with a reason (audited). Reviews are never deleted. */
export const POST = route({
  auth: 'tenant', capability: 'customers.manage', input: reviewModeration,
  handler: async ({ tenant, actor, params, input }) => ({ data: await moderateReview(tenant, actor, requireUuidParam(params, 'id'), input) }),
});
