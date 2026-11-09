import { platformRoute } from '@/server/domains/platform/guard';
import { createMarketer, referralsOverview } from '@/server/domains/referrals/service';
import { marketerCreateInput } from '@/shared/schemas/admin';
import { z } from 'zod';

/** GET /api/v1/platform/referrals — referrers (marketers and businesses) with balances + leaderboard. */
export const GET = platformRoute({
  platformCapability: 'platform.referrals.manage', input: z.object({ kind: z.enum(['marketer', 'business']).optional() }),
  handler: async ({ input }) => ({ data: await referralsOverview(input) }),
});

/** POST /api/v1/platform/referrals — add a marketer (affiliate) with a referral code. */
export const POST = platformRoute({
  platformCapability: 'platform.referrals.manage', input: marketerCreateInput,
  handler: async ({ input, actor }) => ({ status: 201, data: await createMarketer(actor, input) }),
});
