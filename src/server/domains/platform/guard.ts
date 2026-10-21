import type { z } from 'zod';
import { platformMfaState } from './mfa-state';
import { route, type RouteContext } from '../../http/route';
import { AppError } from '../../http/errors';
import { requireStepUp, type SessionUser } from '../../auth/service';
import { platformCapabilities, type PlatformCapability } from '../../auth/capabilities';

export { MFA_SESSION_HOURS, platformMfaState, type PlatformMfaState } from './mfa-state';

/**
 * Guard for every LUMA administration endpoint and page: once a platform user
 * has enabled MFA, the current session must have passed a TOTP check.
 */
export async function requirePlatformMfa(user: Pick<SessionUser, 'sessionId'>) {
  const s = await platformMfaState(user);
  if (s.enabled && !s.verified) throw new AppError(403, 'mfa_required', 'Enter your authenticator code to continue');
}

type PlatformDef<S extends z.ZodTypeAny | undefined> = {
  platformCapability?: PlatformCapability;
  input?: S;
  rateLimit?: { scope: 'ip' | 'user'; limit: number; windowSec: number; name: string };
  idempotency?: 'required' | 'optional';
  /** Password step-up (checked AFTER the platform-role check so non-platform callers still get 404). */
  stepUp?: boolean;
  /** Only the MFA enrolment/verification endpoints themselves. */
  mfaExempt?: boolean;
  handler: (ctx: RouteContext<S extends z.ZodTypeAny ? z.infer<S> : undefined, 'platform'>) => Promise<Response | { data: unknown; status?: number; meta?: Record<string, unknown> }>;
};

/**
 * route() for /api/v1/platform/**: auth 'platform' (non-platform users get 404,
 * hiding existence), least-privilege capability, then MFA, then step-up.
 */
export function platformRoute<S extends z.ZodTypeAny | undefined = undefined>(def: PlatformDef<S>) {
  return route<S, 'platform'>({
    auth: 'platform',
    platformCapability: def.platformCapability,
    input: def.input,
    rateLimit: def.rateLimit,
    idempotency: def.idempotency,
    handler: async (ctx) => {
      if (!def.mfaExempt) await requirePlatformMfa(ctx.user);
      if (def.stepUp) requireStepUp(ctx.user);
      return def.handler(ctx);
    },
  });
}

export function platformCaps(user: Pick<SessionUser, 'platformRoles'>) {
  return platformCapabilities(user.platformRoles);
}
