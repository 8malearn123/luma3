import { platformRoute } from '@/server/domains/platform/guard';
import { decideWithdrawal } from '@/server/domains/referrals/service';
import { requireUuidParam } from '@/server/http/params';
import { withdrawalDecisionInput } from '@/shared/schemas/admin';

/** POST /api/v1/platform/withdrawals/:id — approve, reject (releases the hold) or mark paid (step-up). */
export const POST = platformRoute({
  platformCapability: 'platform.referrals.manage', stepUp: true, input: withdrawalDecisionInput,
  handler: async ({ params, input, actor }) => ({ data: await decideWithdrawal(requireUuidParam(params, 'id'), actor, input) }),
});
