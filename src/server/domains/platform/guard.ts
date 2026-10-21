import type { z } from 'zod';
import { db } from '../../db/client';
import { route, type RouteContext } from '../../http/route';
import { AppError } from '../../http/errors';
import { requireStepUp, type SessionUser } from '../../auth/service';
import { platformCapabilities, type PlatformCapability } from '../../auth/capabilities';

/** A session's second-factor verification is valid for this long. */
export const MFA_SESSION_HOURS = 12;

export type PlatformMfaState = { enabled: boolean; verified: boolean; pending: boolean };

export async function platformMfaState(user: Pick<SessionUser, 'sessionId'>): Promise<PlatformMfaState> {
  const row = await db().selectFrom('sessions as s').innerJoin('users as u', 'u.id', 's.user_id')
    .select(['u.mfa_enabled_at', 'u.mfa_pending_secret_enc', 's.mfa_verified_at'])
    .where('s.id', '=', user.sessionId).executeTakeFirst();
  const verified = !!row?.mfa_verified_at && Date.now() - row.mfa_verified_at.getTime() < MFA_SESSION_HOURS * 3_600_000;
  return { enabled: !!row?.mfa_enabled_at, verified, pending: !!row?.mfa_pending_secret_enc };
}

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
