import { platformRoute } from '@/server/domains/platform/guard';
import { adjustReferralBalance } from '@/server/domains/referrals/service';
import { requireUuidParam } from '@/server/http/params';
import { referralAdjustInput } from '@/shared/schemas/admin';

/** POST /api/v1/platform/referrals/:id/adjust — manual balance correction (append-only ledger entry, step-up). */
export const POST = platformRoute({
  platformCapability: 'platform.referrals.manage', stepUp: true, input: referralAdjustInput,
  handler: async ({ params, input, actor }) => ({ data: await adjustReferralBalance(requireUuidParam(params, 'id'), actor, input) }),
});
