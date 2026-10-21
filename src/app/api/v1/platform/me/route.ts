import { platformRoute, platformCaps, platformMfaState } from '@/server/domains/platform/guard';

/** GET /api/v1/platform/me — roles, capabilities and MFA state (reachable before MFA verification). */
export const GET = platformRoute({
  mfaExempt: true,
  handler: async ({ user }) => ({ data: { roles: user.platformRoles, capabilities: [...platformCaps(user)], mfa: await platformMfaState(user) } }),
});
