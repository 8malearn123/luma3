import { route } from '@/server/http/route';
import { businessReferralOverview } from '@/server/domains/referrals/service';

/** GET /api/v1/t/:slug/referrals — the business's referral code/link, referred businesses, balance and withdrawals. */
export const GET = route({
  auth: 'tenant', capability: 'business.manage',
  handler: async ({ tenant }) => ({ data: await businessReferralOverview(tenant) }),
});
