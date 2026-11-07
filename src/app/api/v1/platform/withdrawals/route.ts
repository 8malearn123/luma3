import { platformRoute } from '@/server/domains/platform/guard';
import { listWithdrawals } from '@/server/domains/referrals/service';
import { withdrawalListQuery } from '@/shared/schemas/admin';

/** GET /api/v1/platform/withdrawals — referral withdrawal queue. */
export const GET = platformRoute({
  platformCapability: 'platform.referrals.manage', input: withdrawalListQuery,
  handler: async ({ input }) => ({ data: await listWithdrawals(input) }),
});
