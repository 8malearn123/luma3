import { platformRoute } from '@/server/domains/platform/guard';
import { disableOwn } from '@/server/domains/platform/mfa';
import { mfaCodeInput } from '@/shared/schemas/platform';

/** POST /api/v1/platform/mfa/disable — turn off own MFA (verified session + step-up + current code). */
export const POST = platformRoute({
  stepUp: true, input: mfaCodeInput,
  handler: async ({ user, actor, input }) => ({ data: await disableOwn(user, input.code, actor) }),
});
