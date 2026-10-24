import { refreshSignedSession } from '@/server/auth/service';
import { sessionCookie } from '@/server/http/route';
import { platformRoute } from '@/server/domains/platform/guard';
import { verifySession } from '@/server/domains/platform/mfa';
import { mfaCodeInput } from '@/shared/schemas/platform';

/** POST /api/v1/platform/mfa/verify — second-factor check for this session. */
export const POST = platformRoute({
  mfaExempt: true, input: mfaCodeInput,
  rateLimit: { scope: 'user', limit: 20, windowSec: 900, name: 'mfa-verify' },
  handler: async ({ user, actor, input, responseInit }) => {
    const data = await verifySession(user, input.code, actor);
    const signed = await refreshSignedSession(user);
    if (signed) responseInit.cookies.push(sessionCookie(signed.token, signed.expiresAt));
    return { data };
  },
});
