import { platformRoute } from '@/server/domains/platform/guard';
import { reviewListing } from '@/server/domains/marketplace/listing';
import { requireUuidParam } from '@/server/http/params';
import { reviewDecisionInput } from '@/shared/schemas/marketplace';

/** POST { decision, reason? } — approve or reject (with a reason) a marketplace join request. */
export const POST = platformRoute({
  platformCapability: 'platform.marketplace.review', input: reviewDecisionInput,
  handler: async ({ params, actor, input }) => ({ data: await reviewListing(requireUuidParam(params, 'tenantId'), actor, input) }),
});
