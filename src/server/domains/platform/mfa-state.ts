import { db } from '../../db/client';
import { env } from '../../env';

/** A session's second-factor verification is valid for this long. */
export const MFA_SESSION_HOURS = 12;

export type PlatformMfaState = { enabled: boolean; verified: boolean; pending: boolean };

/**
 * MFA state of the user behind a session. Dependency-free (db only) so the
 * tenancy layer can use it for support access without an import cycle.
 */
export async function platformMfaState(user: { sessionId: string }): Promise<PlatformMfaState> {
  const row = await db().selectFrom('sessions as s').innerJoin('users as u', 'u.id', 's.user_id')
    .select(['u.mfa_enabled_at', 'u.mfa_pending_secret_enc', 's.mfa_verified_at'])
    .where('s.id', '=', user.sessionId).executeTakeFirst();
  const verified = !!row?.mfa_verified_at && Date.now() - row.mfa_verified_at.getTime() < MFA_SESSION_HOURS * 3_600_000;
  return { enabled: !!row?.mfa_enabled_at, verified, pending: !!row?.mfa_pending_secret_enc };
}

/**
 * True when this session may not act as platform staff yet: MFA is enabled but
 * not passed, or MFA is required (always in production) but not set up.
 */
export async function mfaPending(user: { sessionId: string }) {
  const s = await platformMfaState(user);
  return s.enabled ? !s.verified : env().platformMfaRequired;
}
