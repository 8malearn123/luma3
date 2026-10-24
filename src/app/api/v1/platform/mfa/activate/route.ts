import { refreshSignedSession } from '@/server/auth/service';
import { sessionCookie } from '@/server/http/route';
import { platformRoute } from '@/server/domains/platform/guard';
import { activateEnrollment } from '@/server/domains/platform/mfa';
import { mfaCodeInput } from '@/shared/schemas/platform';

/** POST /api/v1/platform/mfa/activate — confirm the pending secret with a code; enables MFA. */
export const POST = platformRoute({
  mfaExempt: true, input: mfaCodeInput,
  handler: async ({ user, actor, input, responseInit }) => {
    const data = await activateEnrollment(user, input.code, actor);
    const signed = await refreshSignedSession(user);
    if (signed) responseInit.cookies.push(sessionCookie(signed.token, signed.expiresAt));
    return { data };
  },
});
