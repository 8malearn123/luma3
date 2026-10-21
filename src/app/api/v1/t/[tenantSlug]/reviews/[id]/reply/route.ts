import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { replyToReview } from '@/server/domains/reviews/service';
import { reviewReply } from '@/shared/schemas/customers';

export const POST = route({
  auth: 'tenant', capability: 'customers.manage', input: reviewReply,
  handler: async ({ tenant, actor, params, input }) => ({ data: await replyToReview(tenant, actor, requireUuidParam(params, 'id'), input) }),
});
