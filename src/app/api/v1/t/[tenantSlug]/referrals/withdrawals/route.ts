import { route } from '@/server/http/route';
import { businessRequestWithdrawal } from '@/server/domains/referrals/service';
import { withdrawalRequestInput } from '@/shared/schemas/admin';

/** POST /api/v1/t/:slug/referrals/withdrawals — request a payout of the referral balance to an IBAN (owner, step-up). */
export const POST = route({
  auth: 'tenant', capability: 'business.manage', stepUp: true, allowReadOnly: true, input: withdrawalRequestInput,
  rateLimit: { scope: 'user', name: 'referral_withdrawal', limit: 10, windowSec: 3600 },
  handler: async ({ tenant, input, actor }) => ({ status: 201, data: await businessRequestWithdrawal(tenant, actor, input) }),
});
