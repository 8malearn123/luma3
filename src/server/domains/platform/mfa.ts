import { db, withCentral, withSystem } from '../../db/client';
import { Errors } from '../../http/errors';
import { audit, type AuditActor } from '../../infra/audit';
import { enforce } from '../../infra/rate-limit';
import { notifyUsers } from '../../infra/notify';
import { consumeCode, issueCode, type SessionUser } from '../../auth/service';
import { maskDestination } from '../../auth/crypto';
import { env } from '../../env';
import { decryptSecret, encryptSecret, newTotpSecret, otpauthUri, totpStep, verifyTotp } from './totp';

async function loadUser(userId: string) {
  return db().selectFrom('users').select(['id', 'email', 'phone', 'mfa_enabled_at', 'mfa_totp_secret_enc', 'mfa_pending_secret_enc', 'mfa_last_step'])
    .where('id', '=', userId).executeTakeFirstOrThrow();
}

/** Starts (or restarts) enrolment: a new pending secret, shown once for manual entry. */
export async function startEnrollment(user: SessionUser, actor: AuditActor) {
  const u = await loadUser(user.userId);
  if (u.mfa_enabled_at) throw Errors.conflict('mfa_already_enabled', 'Two-step verification is already enabled');
  const secret = newTotpSecret();
  await withCentral(async (trx) => {
    await trx.updateTable('users').set({ mfa_pending_secret_enc: encryptSecret(secret) }).where('id', '=', user.userId).execute();
    await audit(trx, actor, 'platform.mfa.enrollment_started', { targetType: 'user', targetId: user.userId });
  });
  return { secret, otpauth_uri: otpauthUri(secret, u.email ?? u.phone ?? user.userId), digits: 6, period: 30, algorithm: 'SHA1' };
}

async function checkCode(userId: string, code: string, which: 'active' | 'pending') {
  await enforce(`mfa:${userId}`, 10, 900);
  const u = await loadUser(userId);
  const enc = which === 'active' ? u.mfa_totp_secret_enc : u.mfa_pending_secret_enc;
  if (!enc) throw Errors.invalid(which === 'active' ? 'mfa_not_enabled' : 'mfa_not_pending', 'No authenticator is being set up');
  const step = verifyTotp(decryptSecret(enc), code, { afterStep: u.mfa_last_step });
  if (step === null) throw Errors.invalid('mfa_code_invalid', 'The authenticator code is incorrect');
  return { u, step, enc };
}

/** Proves possession of the pending secret, enables MFA and verifies this session. */
export async function activateEnrollment(user: SessionUser, code: string, actor: AuditActor) {
  const { step, enc } = await checkCode(user.userId, code, 'pending');
  await withCentral(async (trx) => {
    await trx.updateTable('users').set({ mfa_totp_secret_enc: enc, mfa_pending_secret_enc: null, mfa_enabled_at: new Date(), mfa_last_step: step })
      .where('id', '=', user.userId).execute();
    await trx.updateTable('sessions').set({ mfa_verified_at: new Date() }).where('id', '=', user.sessionId).execute();
    await audit(trx, actor, 'platform.mfa.enabled', { targetType: 'user', targetId: user.userId });
  });
  return { enabled: true };
}

// ── WhatsApp one-time code (the default second factor) ─────────────────────
/** Embedded demo database only: the second factor is this fixed code; nothing is sent. */
export const DEMO_MFA_CODE = '2002';
export const demoMfa = () => env().DB_DRIVER === 'pglite' && !env().isProduction;

/**
 * Sends a one-time code to the administrator's WhatsApp number. Reports exactly
 * what happened (sent, simulated in development, or unavailable) and never
 * claims a message left the server when no provider is connected.
 */
export async function sendWhatsappCode(user: SessionUser, actor: AuditActor) {
  if (demoMfa()) return { channel: 'whatsapp' as const, demo: true };
  const u = await loadUser(user.userId);
  if (!u.phone) throw Errors.invalid('mfa_no_phone', 'Add a mobile number to your account to receive the code on WhatsApp');
  const delivery = await issueCode({ userId: user.userId, purpose: 'step_up', channel: 'whatsapp', destination: u.phone, locale: user.locale });
  if (delivery.status === 'unavailable') throw Errors.unavailable('whatsapp_unavailable', 'WhatsApp messages cannot be sent right now');
  await withCentral((trx) => audit(trx, actor, 'platform.mfa.code_sent', { targetType: 'user', targetId: user.userId, data: { channel: 'whatsapp' } }));
  return { channel: 'whatsapp' as const, destination: maskDestination(u.phone), delivery };
}

/**
 * Second-factor check for the current session: the WhatsApp code (or the
 * demo's fixed code), or a code from an authenticator app if one is set up.
 */
export async function verifySession(user: SessionUser, code: string, actor: AuditActor) {
  try {
    if (demoMfa()) {
      if (code !== DEMO_MFA_CODE) throw Errors.invalid('mfa_code_invalid', 'The verification code is incorrect');
    } else {
      const u = await loadUser(user.userId);
      let step: number | null = null;
      if (u.mfa_totp_secret_enc && /^\d{6}$/.test(code)) {
        await enforce(`mfa:${user.userId}`, 10, 900);
        step = verifyTotp(decryptSecret(u.mfa_totp_secret_enc), code, { afterStep: u.mfa_last_step });
      }
      if (step !== null) {
        await db().updateTable('users').set({ mfa_last_step: step }).where('id', '=', user.userId).execute();
      } else {
        if (!u.phone) throw Errors.invalid('mfa_code_invalid', 'The verification code is incorrect');
        await consumeCode(u.phone, 'step_up', code).catch((e: { code?: string }) => {
          throw e.code === 'code_invalid' ? Errors.invalid('mfa_code_invalid', 'The verification code is incorrect') : e;
        });
      }
    }
    await withCentral(async (trx) => {
      await trx.updateTable('sessions').set({ mfa_verified_at: new Date() }).where('id', '=', user.sessionId).execute();
      await audit(trx, actor, 'platform.mfa.verified', { targetType: 'session', targetId: user.sessionId });
    });
    return { verified: true };
  } catch (e) {
    if ((e as { code?: string }).code === 'mfa_code_invalid') {
      await withCentral((trx) => audit(trx, actor, 'platform.mfa.verify_failed', { targetType: 'user', targetId: user.userId }));
    }
    throw e;
  }
}

/** The user turns MFA off for themselves (requires step-up AND a valid current code). */
export async function disableOwn(user: SessionUser, code: string, actor: AuditActor) {
  await checkCode(user.userId, code, 'active');
  await withCentral(async (trx) => {
    await trx.updateTable('users').set({ mfa_totp_secret_enc: null, mfa_pending_secret_enc: null, mfa_enabled_at: null, mfa_last_step: null })
      .where('id', '=', user.userId).execute();
    await audit(trx, actor, 'platform.mfa.disabled', { targetType: 'user', targetId: user.userId });
  });
  return { enabled: false };
}

/**
 * Recovery: the platform owner resets another administrator's MFA (lost
 * device). Audited and the affected user is notified; they enrol again.
 */
export async function resetForUser(actorUser: SessionUser, targetUserId: string, reason: string, actor: AuditActor) {
  if (targetUserId === actorUser.userId) throw Errors.invalid('cannot_reset_own_mfa', 'Use your own security page to change your authenticator');
  // System scope: the platform-level notification row (tenant_id NULL) is written with ON CONFLICT.
  return withSystem('platform: reset administrator MFA', async (trx) => {
    const r = await trx.updateTable('users').set({ mfa_totp_secret_enc: null, mfa_pending_secret_enc: null, mfa_enabled_at: null, mfa_last_step: null })
      .where('id', '=', targetUserId).returning('id').executeTakeFirst();
    if (!r) throw Errors.notFound('user');
    await trx.updateTable('sessions').set({ mfa_verified_at: null }).where('user_id', '=', targetUserId).execute();
    await audit(trx, actor, 'platform.mfa.reset', { targetType: 'user', targetId: targetUserId, data: { reason } });
    await notifyUsers(trx, null, [targetUserId], {
      kind: 'platform.mfa_reset',
      title_ar: 'تمت إعادة تعيين التحقق بخطوتين لحسابك الإداري. فعّليه من جديد.',
      title_en: 'Your admin two-step verification was reset. Please enrol again.',
      target_path: '/platform/security',
    });
    return { reset: true };
  });
}

/** Test/diagnostic helper: the current expected step (never exposes codes). */
export const currentStep = () => totpStep();
