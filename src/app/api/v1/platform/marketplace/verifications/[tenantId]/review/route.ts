import { platformRoute } from '@/server/domains/platform/guard';
import { reviewVerification } from '@/server/domains/marketplace/listing';
import { requireUuidParam } from '@/server/http/params';
import { reviewDecisionInput } from '@/shared/schemas/marketplace';

/** POST { decision, reason? } — verify the business or reject its documents with a reason. */
export const POST = platformRoute({
  platformCapability: 'platform.marketplace.review', input: reviewDecisionInput,
  handler: async ({ params, actor, input }) => ({ data: await reviewVerification(requireUuidParam(params, 'tenantId'), actor, input) }),
});
