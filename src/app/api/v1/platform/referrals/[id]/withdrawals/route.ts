import { platformRoute } from '@/server/domains/platform/guard';
import { platformRequestWithdrawal } from '@/server/domains/referrals/service';
import { requireUuidParam } from '@/server/http/params';
import { withdrawalRequestInput } from '@/shared/schemas/admin';

/** POST /api/v1/platform/referrals/:id/withdrawals — record a marketer's withdrawal request (holds the amount). */
export const POST = platformRoute({
  platformCapability: 'platform.referrals.manage', input: withdrawalRequestInput,
  handler: async ({ params, input, actor }) => ({ status: 201, data: await platformRequestWithdrawal(requireUuidParam(params, 'id'), actor, input) }),
});
