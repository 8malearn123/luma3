import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { proposePriceFromRecommendation } from '@/server/domains/marketing/recommendations';
import { pricingProposalFromRecommendation } from '@/shared/schemas/marketing';


/** Owner-initiated: creates a catalog price PROPOSAL (never applies a price). */
export const POST = route({
  auth: 'tenant', capability: 'marketing.manage', feature: 'feature.marketing_ai', input: pricingProposalFromRecommendation,
  handler: async ({ tenant, actor, params, input }) => ({ status: 201, data: await proposePriceFromRecommendation(tenant, actor, requireUuidParam(params, 'id'), input) }),
});
