import { platformRoute, platformMfaState } from '@/server/domains/platform/guard';

/** GET /api/v1/platform/mfa — whether MFA is enabled and verified for this session. */
export const GET = platformRoute({ mfaExempt: true, handler: async ({ user }) => ({ data: await platformMfaState(user) }) });
