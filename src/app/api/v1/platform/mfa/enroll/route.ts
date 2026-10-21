import { platformRoute } from '@/server/domains/platform/guard';
import { startEnrollment } from '@/server/domains/platform/mfa';

/** POST /api/v1/platform/mfa/enroll — new pending TOTP secret (shown once for manual entry). Requires step-up. */
export const POST = platformRoute({
  mfaExempt: true, stepUp: true,
  rateLimit: { scope: 'user', limit: 10, windowSec: 3600, name: 'mfa-enroll' },
  handler: async ({ user, actor }) => ({ data: await startEnrollment(user, actor) }),
});
