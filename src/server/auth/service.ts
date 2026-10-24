import { randomUUID } from 'node:crypto';
import { db, isUuid, withCentral, sql, type Tx } from '../db/client';
import { env } from '../env';
import { AppError, Errors } from '../http/errors';
import { audit, type AuditActor } from '../infra/audit';
import { channelStatus, sendTransactional, type DeliveryResult } from '../infra/messaging';
import { enforce } from '../infra/rate-limit';
import { parseIdentifier } from '@/shared/phone';
import { hashPassword, hashToken, newOtp, newToken, safeEqual, verifyPassword } from './crypto';

export const SESSION_COOKIE = 'luma_session';
const SESSION_ABSOLUTE_DAYS = 30;
const SESSION_IDLE_DAYS = 7;
const CODE_TTL_MIN = 10;
const LOCK_AFTER_FAILURES = 8;
const LOCK_MINUTES = 15;
export const STEP_UP_WINDOW_MIN = 10;

export type Purpose = 'verify_email' | 'verify_phone' | 'login' | 'recovery' | 'step_up';

export type CodeDelivery = {
  status: DeliveryResult['status'];
  /** Present ONLY when DEV_OTP_ECHO is enabled outside production. */
  dev_code?: string;
  channel: 'email' | 'sms' | 'whatsapp';
};

export function validatePassword(pw: string) {
  if (pw.length < 10) throw Errors.invalid('weak_password', 'Password must be at least 10 characters');
  if (pw.length > 200) throw Errors.invalid('weak_password', 'Password is too long');
  if (/^\d+$/.test(pw)) throw Errors.invalid('weak_password', 'Password cannot be only digits');
}

// ── Verification codes ──────────────────────────────────────────────────────
export async function issueCode(opts: { userId: string | null; purpose: Purpose; channel: 'email' | 'sms' | 'whatsapp'; destination: string; locale: 'ar' | 'en' }): Promise<CodeDelivery> {
  await enforce(`code:${opts.destination}`, 5, 3600);
  const code = newOtp();
  // Invalidate earlier unconsumed codes for the same purpose/destination.
  await db().updateTable('verification_codes').set({ consumed_at: new Date() })
    .where('destination', '=', opts.destination).where('purpose', '=', opts.purpose).where('consumed_at', 'is', null).execute();
  await db().insertInto('verification_codes').values({
    user_id: opts.userId,
    purpose: opts.purpose,
    channel: opts.channel,
    destination: opts.destination,
    secret_hash: hashToken(code, `otp:${opts.purpose}`),
    expires_at: new Date(Date.now() + CODE_TTL_MIN * 60_000),
  }).execute();

  const body = opts.locale === 'ar'
    ? `رمز التحقق في لوما: ${code}. صالح لمدة ${CODE_TTL_MIN} دقائق. لا تشاركيه مع أحد.`
    : `Your LUMA code is ${code}. It expires in ${CODE_TTL_MIN} minutes. Do not share it.`;
  const delivery = await sendTransactional({
    channel: opts.channel, to: opts.destination, subject: 'LUMA', body, templateKey: `auth.${opts.purpose}`, locale: opts.locale,
  });
  const out: CodeDelivery = { status: delivery.status, channel: opts.channel };
  if (delivery.status === 'simulated' && env().devOtpEcho) out.dev_code = code;
  return out;
}

export async function consumeCode(destination: string, purpose: Purpose, code: string): Promise<{ userId: string | null }> {
  const row = await db().selectFrom('verification_codes').selectAll()
    .where('destination', '=', destination).where('purpose', '=', purpose).where('consumed_at', 'is', null)
    .orderBy('created_at', 'desc').executeTakeFirst();
  if (!row || row.expires_at < new Date()) throw Errors.invalid('code_invalid', 'The code is invalid or has expired');
  if (row.attempts >= row.max_attempts) throw Errors.invalid('code_attempts_exceeded', 'Too many attempts. Request a new code.');
  const ok = safeEqual(Buffer.from(row.secret_hash), hashToken(code.trim(), `otp:${purpose}`));
  if (!ok) {
    await db().updateTable('verification_codes').set({ attempts: sql`attempts + 1` }).where('id', '=', row.id).execute();
    throw Errors.invalid('code_invalid', 'The code is invalid or has expired');
  }
  const consumed = await db().updateTable('verification_codes').set({ consumed_at: new Date() })
    .where('id', '=', row.id).where('consumed_at', 'is', null).returning('id').executeTakeFirst();
  if (!consumed) throw Errors.invalid('code_invalid', 'The code is invalid or has expired');
  return { userId: row.user_id };
}

// ── Registration ────────────────────────────────────────────────────────────
export async function register(input: { identifier: string; password: string; displayName: string; locale: 'ar' | 'en'; ip: string | null }) {
  await enforce(`register:ip:${input.ip ?? 'unknown'}`, 10, 3600);
  const id = parseIdentifier(input.identifier);
  if (!id) throw Errors.invalid('invalid_identifier', 'Enter a valid email address or mobile number');
  validatePassword(input.password);
  const channel = id.kind === 'email' ? 'email' : 'sms';
  // Never create accounts that can never be verified, and never pretend a code was sent.
  if (channelStatus(channel) === 'disconnected') {
    throw Errors.unavailable('verification_unavailable', 'Verification messages cannot be sent right now');
  }

  const passwordHash = await hashPassword(input.password);
  const userId = await withCentral(async (trx) => {
    const existing = await trx.selectFrom('users').select(['id', 'email_verified_at', 'phone_verified_at'])
      .where(id.kind === 'email' ? 'email' : 'phone', '=', id.value).executeTakeFirst();
    if (existing) {
      // Do not reveal whether an account exists: behave as if a code was sent.
      return null;
    }
    const user = await trx.insertInto('users').values({
      email: id.kind === 'email' ? id.value : null,
      phone: id.kind === 'phone' ? id.value : null,
      password_hash: passwordHash,
      display_name: input.displayName.trim(),
      locale: input.locale,
    }).returning('id').executeTakeFirstOrThrow();
    await trx.insertInto('customer_profiles').values({ user_id: user.id }).execute();
    await audit(trx, { userId: user.id, kind: 'customer', ip: input.ip }, 'auth.register', { targetType: 'user', targetId: user.id });
    return user.id;
  });

  const purpose: Purpose = id.kind === 'email' ? 'verify_email' : 'verify_phone';
  let delivery: CodeDelivery;
  if (userId) {
    delivery = await issueCode({ userId, purpose, channel, destination: id.value, locale: input.locale });
  } else {
    // Existing account: send a recovery hint instead, keeping the response shape identical.
    delivery = await issueCode({ userId: null, purpose: 'recovery', channel, destination: id.value, locale: input.locale })
      .then((d) => ({ status: d.status, channel: d.channel }));
  }
  return { delivery, destination: id.value, kind: id.kind };
}

export async function requestVerification(userId: string, kind: 'email' | 'phone', locale: 'ar' | 'en') {
  const user = await db().selectFrom('users').select(['email', 'phone', 'email_verified_at', 'phone_verified_at']).where('id', '=', userId).executeTakeFirstOrThrow();
  const dest = kind === 'email' ? user.email : user.phone;
  if (!dest) throw Errors.invalid('no_destination', 'No contact of this type on your account');
  if ((kind === 'email' && user.email_verified_at) || (kind === 'phone' && user.phone_verified_at)) {
    throw Errors.invalid('already_verified', 'Already verified');
  }
  return issueCode({ userId, purpose: kind === 'email' ? 'verify_email' : 'verify_phone', channel: kind === 'email' ? 'email' : 'sms', destination: dest, locale });
}

export async function verifyContact(input: { identifier: string; code: string; ip: string | null }) {
  await enforce(`verify:ip:${input.ip ?? 'unknown'}`, 30, 900);
  const id = parseIdentifier(input.identifier);
  if (!id) throw Errors.invalid('invalid_identifier');
  const purpose: Purpose = id.kind === 'email' ? 'verify_email' : 'verify_phone';
  const { userId } = await consumeCode(id.value, purpose, input.code);
  if (!userId) throw Errors.invalid('code_invalid');
  await withCentral(async (trx) => {
    await trx.updateTable('users')
      .set(id.kind === 'email' ? { email_verified_at: new Date() } : { phone_verified_at: new Date() })
      .where('id', '=', userId).execute();
    await audit(trx, { userId, kind: 'customer', ip: input.ip }, `auth.verify_${id.kind}`, { targetType: 'user', targetId: userId });
  });
  return { userId };
}

// ── Login / sessions ────────────────────────────────────────────────────────
export async function login(input: { identifier: string; password: string; ip: string | null; userAgent: string | null }) {
  const id = parseIdentifier(input.identifier);
  await enforce(`login:ip:${input.ip ?? 'unknown'}`, 30, 900);
  if (!id) throw Errors.invalid('invalid_credentials', 'Incorrect sign-in details');
  await enforce(`login:id:${id.value}`, 10, 900);

  const user = await db().selectFrom('users').selectAll().where(id.kind === 'email' ? 'email' : 'phone', '=', id.value).executeTakeFirst();
  if (user?.locked_until && user.locked_until > new Date()) {
    throw new AppError(429, 'account_locked', 'Too many failed attempts. Try again later or reset your password.', {
      retry_after_sec: Math.ceil((user.locked_until.getTime() - Date.now()) / 1000),
    });
  }
  const ok = await verifyPassword(input.password, user?.password_hash);
  if (!user || !ok || user.status !== 'active') {
    if (user) {
      const failures = user.failed_login_count + 1;
      await db().updateTable('users').set({
        failed_login_count: failures,
        locked_until: failures >= LOCK_AFTER_FAILURES ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null,
      }).where('id', '=', user.id).execute();
    }
    throw Errors.invalid('invalid_credentials', 'Incorrect sign-in details');
  }
  await db().updateTable('users').set({ failed_login_count: 0, locked_until: null }).where('id', '=', user.id).execute();
  const session = await createSession(user.id, input.ip, input.userAgent);
  await withCentral((trx) => audit(trx, { userId: user.id, kind: 'user', ip: input.ip }, 'auth.login', { targetType: 'session', targetId: session.id }));
  return { ...session, userId: user.id };
}

export async function createSession(userId: string, ip: string | null, userAgent: string | null, trx?: Tx) {
  const now = Date.now();
  const expiresAt = new Date(now + SESSION_ABSOLUTE_DAYS * 86_400_000);
  const id = randomUUID();
  const token = embeddedDb() ? signedSessionToken({ sessionId: id, userId, expiresAt: expiresAt.getTime(), signedInAt: now, mfaAt: 0 }) : newToken();
  const row = await (trx ?? db()).insertInto('sessions').values({
    id,
    user_id: userId,
    token_hash: hashToken(token, 'session'),
    expires_at: expiresAt,
    idle_expires_at: new Date(now + SESSION_IDLE_DAYS * 86_400_000),
    reauthenticated_at: new Date(now),
    ip,
    user_agent: userAgent?.slice(0, 300) ?? null,
  }).returning(['id', 'expires_at']).executeTakeFirstOrThrow();
  return { id: row.id, token, expiresAt: row.expires_at };
}

// ── Embedded demo database: sessions that survive across server instances ──
// Each server instance has its own in-memory copy of the demo data, so a
// session created on one is unknown to the next. In that mode the cookie is a
// self-contained token signed with the per-build AUTH_SECRET (sign-in time and
// second-factor time included); an instance that has not seen the session, or
// holds an older copy of it, rebuilds it from the verified token.
const embeddedDb = () => env().DB_DRIVER === 'pglite';
const SIGNED_PREFIX = 'e1';

type SignedSession = { sessionId: string; userId: string; expiresAt: number; signedInAt: number; mfaAt: number };

function signedSessionToken(t: SignedSession) {
  const body = [SIGNED_PREFIX, t.sessionId, t.userId, t.expiresAt, t.signedInAt, t.mfaAt].join('.');
  return `${body}.${hashToken(body, 'signed-session').toString('base64url')}`;
}

function readSignedSession(token: string): SignedSession | null {
  const parts = token.split('.');
  if (parts.length !== 7 || parts[0] !== SIGNED_PREFIX) return null;
  if (!safeEqual(Buffer.from(parts[6]!, 'base64url'), hashToken(parts.slice(0, 6).join('.'), 'signed-session'))) return null;
  const [sessionId, userId] = [parts[1]!, parts[2]!];
  const [expiresAt, signedInAt, mfaAt] = parts.slice(3, 6).map(Number) as [number, number, number];
  if (!isUuid(sessionId) || !isUuid(userId) || ![expiresAt, signedInAt, mfaAt].every(Number.isSafeInteger) || expiresAt < Date.now()) return null;
  return { sessionId, userId, expiresAt, signedInAt, mfaAt };
}

async function restoreSignedSession(token: string) {
  const t = readSignedSession(token);
  // The user may not exist on this instance (e.g. registered on another one): stay signed out.
  if (!t || !(await db().selectFrom('users').select('id').where('id', '=', t.userId).executeTakeFirst())) return;
  const tokenHash = hashToken(token, 'session');
  const mfaVerifiedAt = t.mfaAt ? new Date(t.mfaAt) : null;
  await db().insertInto('sessions').values({
    id: t.sessionId,
    user_id: t.userId,
    token_hash: tokenHash,
    expires_at: new Date(t.expiresAt),
    idle_expires_at: new Date(Math.min(t.expiresAt, Date.now() + SESSION_IDLE_DAYS * 86_400_000)),
    reauthenticated_at: new Date(t.signedInAt),
    mfa_verified_at: mfaVerifiedAt,
  }).onConflict((oc) => oc.column('id').doUpdateSet({ token_hash: tokenHash, mfa_verified_at: mfaVerifiedAt })).execute();
}

/**
 * Embedded demo database only: after the session passes the second factor,
 * returns a new cookie token that carries that fact to every server instance.
 */
export async function refreshSignedSession(user: SessionUser): Promise<{ token: string; expiresAt: Date } | null> {
  if (!embeddedDb()) return null;
  const s = await db().selectFrom('sessions').select(['expires_at', 'created_at', 'mfa_verified_at']).where('id', '=', user.sessionId).executeTakeFirst();
  if (!s) return null;
  const token = signedSessionToken({
    sessionId: user.sessionId, userId: user.userId, expiresAt: s.expires_at.getTime(),
    signedInAt: (user.reauthenticatedAt ?? s.created_at).getTime(), mfaAt: s.mfa_verified_at?.getTime() ?? 0,
  });
  await db().updateTable('sessions').set({ token_hash: hashToken(token, 'session') }).where('id', '=', user.sessionId).execute();
  return { token, expiresAt: s.expires_at };
}

export type SessionUser = {
  sessionId: string;
  userId: string;
  displayName: string;
  email: string | null;
  phone: string | null;
  emailVerified: boolean;
  phoneVerified: boolean;
  locale: 'ar' | 'en';
  timeFormat: '12h' | '24h';
  isDemo: boolean;
  platformRoles: string[];
  reauthenticatedAt: Date | null;
};

function findSession(token: string) {
  return db().selectFrom('sessions as s').innerJoin('users as u', 'u.id', 's.user_id')
    .select(['s.id as session_id', 's.user_id', 's.expires_at', 's.idle_expires_at', 's.revoked_at', 's.last_seen_at', 's.reauthenticated_at',
      'u.display_name', 'u.email', 'u.phone', 'u.email_verified_at', 'u.phone_verified_at', 'u.locale', 'u.time_format', 'u.status', 'u.is_demo'])
    .where('s.token_hash', '=', hashToken(token, 'session')).executeTakeFirst();
}

/** Resolves a session cookie value. Slides the idle expiry at most once per hour. */
export async function resolveSession(token: string | undefined | null): Promise<SessionUser | null> {
  if (!token || token.length > 200) return null;
  const row = await findSession(token) ?? (embeddedDb() ? await restoreSignedSession(token).then(() => findSession(token)) : undefined);
  const now = new Date();
  if (!row || row.revoked_at || row.expires_at < now || row.idle_expires_at < now || row.status !== 'active') return null;
  if (now.getTime() - row.last_seen_at.getTime() > 3_600_000) {
    await db().updateTable('sessions').set({
      last_seen_at: now,
      idle_expires_at: new Date(Math.min(row.expires_at.getTime(), now.getTime() + SESSION_IDLE_DAYS * 86_400_000)),
    }).where('id', '=', row.session_id).execute();
  }
  const roles = await db().selectFrom('platform_roles').select('role').where('user_id', '=', row.user_id).where('revoked_at', 'is', null).execute();
  return {
    sessionId: row.session_id,
    userId: row.user_id,
    displayName: row.display_name,
    email: row.email,
    phone: row.phone,
    emailVerified: !!row.email_verified_at,
    phoneVerified: !!row.phone_verified_at,
    locale: row.locale as 'ar' | 'en',
    timeFormat: row.time_format as '12h' | '24h',
    isDemo: row.is_demo,
    platformRoles: roles.map((r) => r.role),
    reauthenticatedAt: row.reauthenticated_at,
  };
}

export async function logout(sessionId: string) {
  await db().updateTable('sessions').set({ revoked_at: new Date(), revoke_reason: 'logout' }).where('id', '=', sessionId).where('revoked_at', 'is', null).execute();
}

export async function listSessions(userId: string) {
  return db().selectFrom('sessions').select(['id', 'created_at', 'last_seen_at', 'expires_at', 'ip', 'user_agent'])
    .where('user_id', '=', userId).where('revoked_at', 'is', null).where('expires_at', '>', new Date())
    .orderBy('last_seen_at', 'desc').execute();
}

export async function revokeSession(userId: string, sessionId: string, actor: AuditActor) {
  const r = await db().updateTable('sessions').set({ revoked_at: new Date(), revoke_reason: 'user_revoked' })
    .where('id', '=', sessionId).where('user_id', '=', userId).where('revoked_at', 'is', null).returning('id').executeTakeFirst();
  if (!r) throw Errors.notFound('session');
  await withCentral((trx) => audit(trx, actor, 'auth.session_revoked', { targetType: 'session', targetId: sessionId }));
}

export async function revokeAllSessions(userId: string, reason: string, exceptSessionId?: string) {
  let q = db().updateTable('sessions').set({ revoked_at: new Date(), revoke_reason: reason }).where('user_id', '=', userId).where('revoked_at', 'is', null);
  if (exceptSessionId) q = q.where('id', '<>', exceptSessionId);
  await q.execute();
}

// ── Recovery ────────────────────────────────────────────────────────────────
export async function requestRecovery(input: { identifier: string; locale: 'ar' | 'en'; ip: string | null }) {
  await enforce(`recovery:ip:${input.ip ?? 'unknown'}`, 10, 3600);
  const id = parseIdentifier(input.identifier);
  if (!id) throw Errors.invalid('invalid_identifier');
  const user = await db().selectFrom('users').select(['id']).where(id.kind === 'email' ? 'email' : 'phone', '=', id.value).executeTakeFirst();
  const channel = id.kind === 'email' ? 'email' : 'sms';
  if (!user) {
    // Same response shape whether or not the account exists.
    return { delivery: { status: env().devOtpEcho ? 'simulated' : 'unavailable', channel } as CodeDelivery };
  }
  const delivery = await issueCode({ userId: user.id, purpose: 'recovery', channel, destination: id.value, locale: input.locale });
  return { delivery };
}

export async function resetPassword(input: { identifier: string; code: string; newPassword: string; ip: string | null }) {
  await enforce(`reset:ip:${input.ip ?? 'unknown'}`, 20, 3600);
  const id = parseIdentifier(input.identifier);
  if (!id) throw Errors.invalid('invalid_identifier');
  validatePassword(input.newPassword);
  const { userId } = await consumeCode(id.value, 'recovery', input.code);
  const user = await db().selectFrom('users').select('id').where(id.kind === 'email' ? 'email' : 'phone', '=', id.value).executeTakeFirst();
  if (!user || (userId && userId !== user.id)) throw Errors.invalid('code_invalid');
  const hash = await hashPassword(input.newPassword);
  await withCentral(async (trx) => {
    await trx.updateTable('users').set({
      password_hash: hash, failed_login_count: 0, locked_until: null,
      // Receiving the code proves control of this contact.
      ...(id.kind === 'email' ? { email_verified_at: sql`coalesce(email_verified_at, now())` } : { phone_verified_at: sql`coalesce(phone_verified_at, now())` }),
    }).where('id', '=', user.id).execute();
    await trx.updateTable('sessions').set({ revoked_at: new Date(), revoke_reason: 'password_reset' }).where('user_id', '=', user.id).where('revoked_at', 'is', null).execute();
    await audit(trx, { userId: user.id, kind: 'user', ip: input.ip }, 'auth.password_reset', { targetType: 'user', targetId: user.id });
  });
}

export async function changePassword(input: { userId: string; sessionId: string; currentPassword: string; newPassword: string; ip: string | null }) {
  const user = await db().selectFrom('users').select('password_hash').where('id', '=', input.userId).executeTakeFirstOrThrow();
  if (!(await verifyPassword(input.currentPassword, user.password_hash))) throw Errors.invalid('invalid_credentials');
  validatePassword(input.newPassword);
  const hash = await hashPassword(input.newPassword);
  await withCentral(async (trx) => {
    await trx.updateTable('users').set({ password_hash: hash }).where('id', '=', input.userId).execute();
    await trx.updateTable('sessions').set({ revoked_at: new Date(), revoke_reason: 'password_changed' })
      .where('user_id', '=', input.userId).where('id', '<>', input.sessionId).where('revoked_at', 'is', null).execute();
    await audit(trx, { userId: input.userId, kind: 'user', ip: input.ip }, 'auth.password_changed', { targetType: 'user', targetId: input.userId });
  });
}

/** Step-up authentication for sensitive actions (policy decisions, exports, role changes). */
export async function reauthenticate(input: { userId: string; sessionId: string; password: string; ip: string | null }) {
  await enforce(`reauth:${input.userId}`, 10, 900);
  const user = await db().selectFrom('users').select('password_hash').where('id', '=', input.userId).executeTakeFirstOrThrow();
  if (!(await verifyPassword(input.password, user.password_hash))) throw Errors.invalid('invalid_credentials');
  await db().updateTable('sessions').set({ reauthenticated_at: new Date() }).where('id', '=', input.sessionId).execute();
}

export function hasRecentStepUp(u: SessionUser) {
  return !!u.reauthenticatedAt && Date.now() - u.reauthenticatedAt.getTime() < STEP_UP_WINDOW_MIN * 60_000;
}

export function requireStepUp(u: SessionUser) {
  if (!hasRecentStepUp(u)) throw new AppError(401, 'reauthentication_required', 'Please confirm your password to continue');
}

/** Development-only dev outbox reader (labelled in the UI). */
export async function devOutbox(destination: string) {
  if (!env().devOtpEcho) throw Errors.notFound();
  return db().selectFrom('dev_message_outbox').selectAll().where('destination', '=', destination).orderBy('created_at', 'desc').limit(5).execute();
}
