import { createHmac } from 'node:crypto';
import { withTenant, type Tx } from '../../db/client';
import { env } from '../../env';
import { Errors } from '../../http/errors';
import { audit, type AuditActor } from '../../infra/audit';
import { safeEqual } from '../../auth/crypto';
import { CONSENT_CHANNELS, CONSENT_PURPOSES, type ConsentChannel, type ConsentPurpose } from '@/shared/schemas/customers';

/**
 * Consent history is append-only (customer_consents). The effective state for
 * (business, customer, channel, purpose) is the most recent row; no row means
 * NOT granted. Every change is a new row with its source.
 */
export type EffectiveConsent = { granted: boolean; recorded_at: Date | null; source: string | null };

export async function effectiveConsent(trx: Tx, tenantId: string, tenantCustomerId: string, channel: ConsentChannel, purpose: ConsentPurpose = 'marketing'): Promise<EffectiveConsent> {
  const row = await trx.selectFrom('customer_consents').select(['granted', 'recorded_at', 'source'])
    .where('tenant_id', '=', tenantId).where('tenant_customer_id', '=', tenantCustomerId).where('channel', '=', channel).where('purpose', '=', purpose)
    .orderBy('recorded_at', 'desc').orderBy('id', 'desc').limit(1).executeTakeFirst();
  return row ? { granted: row.granted, recorded_at: row.recorded_at, source: row.source } : { granted: false, recorded_at: null, source: null };
}

/** All channels × purposes for one relationship. */
export async function effectiveConsents(trx: Tx, tenantId: string, tenantCustomerIds: string[]) {
  const out = new Map<string, Record<string, Record<string, EffectiveConsent>>>();
  for (const id of tenantCustomerIds) {
    const blank: Record<string, Record<string, EffectiveConsent>> = {};
    for (const p of CONSENT_PURPOSES) {
      blank[p] = {};
      for (const c of CONSENT_CHANNELS) blank[p]![c] = { granted: false, recorded_at: null, source: null };
    }
    out.set(id, blank);
  }
  if (!tenantCustomerIds.length) return out;
  const rows = await trx.selectFrom('customer_consents').select(['tenant_customer_id', 'channel', 'purpose', 'granted', 'recorded_at', 'source'])
    .where('tenant_id', '=', tenantId).where('tenant_customer_id', 'in', tenantCustomerIds)
    .orderBy('recorded_at', 'asc').orderBy('id', 'asc').execute();
  for (const r of rows) {
    const m = out.get(r.tenant_customer_id!);
    if (m?.[r.purpose]) m[r.purpose]![r.channel] = { granted: r.granted, recorded_at: r.recorded_at, source: r.source };
  }
  return out;
}

export async function recordConsent(trx: Tx, v: {
  tenantId: string; tenantCustomerId: string; userId: string | null; channel: ConsentChannel; purpose: ConsentPurpose; granted: boolean;
  source: 'signup' | 'checkout' | 'account' | 'dashboard' | 'unsubscribe_link' | 'import'; recordedBy: string | null; actor: AuditActor;
}) {
  const row = await trx.insertInto('customer_consents').values({
    tenant_id: v.tenantId, tenant_customer_id: v.tenantCustomerId, user_id: v.userId, channel: v.channel, purpose: v.purpose,
    granted: v.granted, source: v.source, recorded_by: v.recordedBy,
  }).returning(['id', 'channel', 'purpose', 'granted', 'source', 'recorded_at']).executeTakeFirstOrThrow();
  await audit(trx, v.actor, v.granted ? 'consent.granted' : 'consent.withdrawn', {
    tenantId: v.tenantId, targetType: 'tenant_customer', targetId: v.tenantCustomerId, data: { channel: v.channel, purpose: v.purpose, source: v.source },
  });
  return row;
}

// ── Suppression ─────────────────────────────────────────────────────────────
/** Keyed hash of a destination; marketing sends must skip rows in suppression_list with this hash. */
export function suppressionHash(channel: 'email' | 'sms' | 'whatsapp', destination: string): Buffer {
  // One normalisation for every writer/reader of suppression_list (unsubscribe links, manual suppression, campaign sends).
  const norm = channel === 'email' ? destination.trim().toLowerCase() : destination.replace(/[^\d+]/g, '');
  return createHmac('sha256', env().AUTH_SECRET).update(`suppression:${channel}:${norm}`).digest();
}

export async function isSuppressed(trx: Tx, tenantId: string, channel: 'email' | 'sms' | 'whatsapp', destination: string) {
  const r = await trx.selectFrom('suppression_list').select('id').where('tenant_id', '=', tenantId).where('channel', '=', channel)
    .where('destination_hash', '=', suppressionHash(channel, destination)).executeTakeFirst();
  return !!r;
}

// ── One-click unsubscribe tokens ────────────────────────────────────────────
type UnsubPayload = { v: 1; t: string; c: string; ch: ConsentChannel; p: ConsentPurpose };

function sign(body: string) {
  return createHmac('sha256', env().AUTH_SECRET).update(`unsubscribe:${body}`).digest('base64url');
}

/**
 * Signed, login-free token: `<base64url(payload)>.<hmac>`. It identifies one
 * relationship + channel + purpose and never expires (unsubscribing must keep
 * working for old emails). It grants nothing except recording a withdrawal.
 */
export function createUnsubscribeToken(tenantId: string, tenantCustomerId: string, channel: ConsentChannel = 'email', purpose: ConsentPurpose = 'marketing') {
  const body = Buffer.from(JSON.stringify({ v: 1, t: tenantId, c: tenantCustomerId, ch: channel, p: purpose } satisfies UnsubPayload)).toString('base64url');
  return `${body}.${sign(body)}`;
}

/** Absolute link for email footers / List-Unsubscribe: `${APP_URL}/unsubscribe?token=…`. */
export function unsubscribeUrl(tenantId: string, tenantCustomerId: string, channel: ConsentChannel = 'email', purpose: ConsentPurpose = 'marketing') {
  return `${env().APP_URL.replace(/\/$/, '')}/unsubscribe?token=${encodeURIComponent(createUnsubscribeToken(tenantId, tenantCustomerId, channel, purpose))}`;
}

export function verifyUnsubscribeToken(token: string): UnsubPayload {
  const [body, sig] = token.split('.');
  if (!body || !sig) throw Errors.invalid('invalid_unsubscribe_token', 'This unsubscribe link is invalid');
  if (!safeEqual(Buffer.from(sig), Buffer.from(sign(body)))) throw Errors.invalid('invalid_unsubscribe_token', 'This unsubscribe link is invalid');
  let p: UnsubPayload;
  try { p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as UnsubPayload; } catch { throw Errors.invalid('invalid_unsubscribe_token'); }
  const uuid = /^[0-9a-f-]{36}$/i;
  if (p.v !== 1 || !uuid.test(p.t) || !uuid.test(p.c) || !CONSENT_CHANNELS.includes(p.ch) || !CONSENT_PURPOSES.includes(p.p)) throw Errors.invalid('invalid_unsubscribe_token');
  return p;
}

/** Records the withdrawal and suppresses the destination. Idempotent. */
export async function applyUnsubscribe(token: string, actor: AuditActor) {
  const p = verifyUnsubscribeToken(token);
  // The tenant id comes from a verified signature, never from free input.
  return withTenant(p.t, async (trx) => {
    const tc = await trx.selectFrom('tenant_customers').select(['id', 'user_id', 'email', 'phone']).where('tenant_id', '=', p.t).where('id', '=', p.c).executeTakeFirst();
    if (!tc) throw Errors.invalid('invalid_unsubscribe_token');
    const t = await trx.selectFrom('tenants').select(['name']).where('id', '=', p.t).executeTakeFirstOrThrow();
    const cur = await effectiveConsent(trx, p.t, tc.id, p.ch, p.p);
    if (cur.granted || !cur.recorded_at) {
      await recordConsent(trx, { tenantId: p.t, tenantCustomerId: tc.id, userId: tc.user_id, channel: p.ch, purpose: p.p, granted: false, source: 'unsubscribe_link', recordedBy: null, actor });
    }
    const dest = p.ch === 'email' ? tc.email : p.ch === 'sms' || p.ch === 'whatsapp' ? tc.phone : null;
    if (dest && p.ch !== 'push' && p.p === 'marketing') {
      await trx.insertInto('suppression_list').values({ tenant_id: p.t, channel: p.ch, destination_hash: suppressionHash(p.ch, dest), reason: 'unsubscribed' })
        .onConflict((oc) => oc.columns(['tenant_id', 'channel', 'destination_hash']).doNothing()).execute();
    }
    return { business_name: t.name, channel: p.ch, purpose: p.p, unsubscribed: true };
  });
}
