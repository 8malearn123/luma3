import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import type { z } from 'zod';
import { withSystem, withTenant, type Tx } from '../../db/client';
import { env } from '../../env';
import { Errors } from '../../http/errors';
import { audit, type AuditActor } from '../../infra/audit';
import { idempotent, requestHash } from '../../infra/idempotency';
import { channelStatus, sendTransactional, type Channel, type DeliveryResult } from '../../infra/messaging';
import { notifyUsers } from '../../infra/notify';
import type { SessionUser } from '../../auth/service';
import { hashToken, newHumanCode, newToken, normalizeHumanCode } from '../../auth/crypto';
import { ensureTenantCustomerForUser } from '../customers/relationship';
import { createStoredValueCheckout } from '../payments/service';
import { formatMoney } from '@/shared/format';
import { normalizePhone } from '@/shared/phone';
import type { giftCardPurchaseInput } from '@/shared/schemas/customer-experience';
import { entry } from './service';

/**
 * Online gift card purchase with direct send («بطاقات الإهداء أونلاين»).
 *
 *  1. purchaseGiftCard: a `pending` card (balance 0) + a delivery row
 *     (`awaiting_payment`) + a hosted provider checkout (sandbox in dev).
 *  2. Capture (webhook → applyCaptured → paymentTargets.giftCard.onCaptured):
 *     the card is activated exactly once (ledger `issue` entry), the journal
 *     posts Dr cash/clearing, Cr gift_card_liability, and the delivery becomes
 *     `scheduled` for the buyer's chosen time.
 *  3. deliverDueGiftCards (periodic): at send time the recipient gets her code
 *     and a private link (/s/{slug}/gift/{token}) through the messaging
 *     abstraction. Status is recorded honestly: `sent` (provider accepted),
 *     `simulated` (development outbox), or retried with backoff and finally
 *     `failed` when no provider is connected.
 *
 * Code at rest: the card keeps only the keyed hash + last 4 characters. To be
 * able to send it later and show it on the recipient page, the code is also
 * stored encrypted (AES-256-GCM, key derived from AUTH_SECRET) on the delivery.
 */
const PAYMENT_TTL_MIN = 30;
const MAX_ATTEMPTS = 5;
const VALIDITY_DAYS = 365;

function key() {
  return Buffer.from(hkdfSync('sha256', env().AUTH_SECRET, 'luma-giftcard-v1', 'gift-code-encryption', 32));
}
export function encryptCode(code: string) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([c.update(code, 'utf8'), c.final()]);
  return `v1.${iv.toString('base64url')}.${c.getAuthTag().toString('base64url')}.${ct.toString('base64url')}`;
}
export function decryptCode(stored: string) {
  const [v, iv, tag, ct] = stored.split('.');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('unsupported gift code format');
  const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}
const viewHash = (token: string) => hashToken(token, 'gift-view');

export async function purchaseGiftCard(tenantId: string, slug: string, user: SessionUser, input: z.infer<typeof giftCardPurchaseInput>, opts: { idempotencyKey: string; actor: AuditActor; now?: Date }) {
  const now = opts.now ?? new Date();
  const phone = input.recipient_phone ? normalizePhone(input.recipient_phone) : null;
  if (input.recipient_phone && !phone) throw Errors.invalid('invalid_phone', 'Enter a valid mobile number');
  const sendAt = input.send_at ? new Date(input.send_at) : now;
  if (sendAt.getTime() < now.getTime() - 5 * 60_000) throw Errors.invalid('send_at_in_past', 'Choose a send time in the future');
  if (sendAt.getTime() > now.getTime() + 365 * 86_400_000) throw Errors.invalid('send_at_too_far', 'Choose a send time within a year');
  const scope = `tenant:${tenantId}:user:${user.userId}`;
  return withTenant(tenantId, (trx) => idempotent(trx, { scope, operation: 'giftcard.purchase', key: opts.idempotencyKey, hash: requestHash(input) }, async () => {
    const tcId = await ensureTenantCustomerForUser(trx, tenantId, { userId: user.userId, displayName: user.displayName, phone: user.phone, email: user.email });
    const code = newHumanCode();
    const card = await trx.insertInto('gift_cards').values({
      tenant_id: tenantId, code_hash: hashToken(normalizeHumanCode(code), 'giftcard'), code_last4: normalizeHumanCode(code).slice(-4),
      initial_minor: input.amount_minor, balance_minor: 0, status: 'pending', template_key: input.template_key,
      purchaser_customer_id: tcId, recipient_name: input.recipient_name, recipient_contact: phone ?? input.recipient_email ?? null, message: input.message ?? null,
    }).returning('id').executeTakeFirstOrThrow();
    const delivery = await trx.insertInto('gift_card_deliveries').values({
      tenant_id: tenantId, gift_card_id: card.id, purchaser_user_id: user.userId, recipient_name: input.recipient_name,
      recipient_phone: phone, recipient_email: input.recipient_email ?? null, message: input.message ?? null, send_at: sendAt,
      status: 'awaiting_payment', code_ciphertext: encryptCode(code),
    }).returning('id').executeTakeFirstOrThrow();
    const payment = await createStoredValueCheckout(trx, {
      tenantId, purpose: 'gift_card', giftCardId: card.id, amountMinor: input.amount_minor, payerUserId: user.userId,
      idempotencyKey: `giftcard:${card.id}:${opts.idempotencyKey}`, description: 'Gift card', returnUrl: `/s/${slug}/gift-cards/purchase/${card.id}`,
      expiresAt: new Date(now.getTime() + PAYMENT_TTL_MIN * 60_000),
    });
    await audit(trx, opts.actor, 'giftcard.purchase_started', { tenantId, targetType: 'gift_card', targetId: card.id, data: { amount_minor: input.amount_minor, send_at: sendAt.toISOString() } });
    return { status: 201, body: { gift_card_id: card.id, delivery_id: delivery.id, send_at: sendAt.toISOString(), payment } };
  }));
}

/** paymentTargets.giftCard.onCaptured: activates the card once and schedules its delivery. */
export async function activatePurchasedGiftCard(trx: Tx, tenantId: string, cardId: string, payment: { paymentId: string; amountMinor: number }) {
  const card = await trx.selectFrom('gift_cards').select(['id', 'status', 'initial_minor']).where('id', '=', cardId).forUpdate().executeTakeFirstOrThrow();
  if (card.status !== 'pending') return { changed: false };
  const now = new Date();
  await trx.updateTable('gift_cards').set({ status: 'active', activated_at: now, expires_at: new Date(now.getTime() + VALIDITY_DAYS * 86_400_000) }).where('id', '=', cardId).execute();
  await entry(trx, tenantId, cardId, 'issue', card.initial_minor, { type: 'payment', id: payment.paymentId });
  const d = await trx.updateTable('gift_card_deliveries').set({ status: 'scheduled', next_attempt_at: null })
    .where('gift_card_id', '=', cardId).where('status', '=', 'awaiting_payment').returning(['purchaser_user_id', 'send_at', 'recipient_name']).executeTakeFirst();
  if (d) {
    await notifyUsers(trx, tenantId, [d.purchaser_user_id], {
      kind: 'giftcard.purchased', title_ar: `تم شراء بطاقة الإهداء لـ ${d.recipient_name}`, title_en: `Gift card for ${d.recipient_name} purchased`,
      body_ar: 'سنرسلها لها في الموعد الذي اخترتِه.', body_en: 'We will send it at the time you chose.', dedupe_key: `giftcard.purchased:${cardId}`,
    });
  }
  return { changed: true };
}

/** Buyer's view of her purchase (status of the payment, the card and the scheduled send). */
export async function giftPurchaseStatus(tenantId: string, userId: string, cardId: string) {
  return withTenant(tenantId, async (trx) => {
    const r = await trx.selectFrom('gift_card_deliveries as d').innerJoin('gift_cards as g', 'g.id', 'd.gift_card_id')
      .select(['g.id', 'g.status as card_status', 'g.initial_minor', 'g.code_last4', 'g.template_key', 'd.recipient_name', 'd.send_at', 'd.status as delivery_status', 'd.sent_at', 'd.channels', 'd.purchaser_user_id'])
      .where('g.id', '=', cardId).executeTakeFirst();
    if (!r || r.purchaser_user_id !== userId) throw Errors.notFound('gift_card');
    const pay = await trx.selectFrom('payments').select(['id', 'status', 'checkout_url']).where('gift_card_id', '=', cardId).orderBy('created_at', 'desc').executeTakeFirst();
    const { purchaser_user_id: _p, ...rest } = r;
    return { ...rest, payment: pay ?? null };
  });
}

type DueDelivery = { id: string; tenant_id: string };

function pickChannels(phone: string | null, email: string | null, tenantChannels: string[]): Array<{ channel: Channel; to: string }> {
  const out: Array<{ channel: Channel; to: string }> = [];
  if (phone) {
    // WhatsApp when connected (or preferred by the business), otherwise SMS.
    const wa = channelStatus('whatsapp') === 'connected' || (channelStatus('sms') !== 'connected' && tenantChannels.includes('whatsapp'));
    out.push({ channel: wa ? 'whatsapp' : 'sms', to: phone });
  }
  if (email) out.push({ channel: 'email', to: email });
  return out;
}

/** Sends one due delivery. Exactly-once per attempt by the row lock + status guard. */
export async function deliverGiftCard(tenantId: string, deliveryId: string, now = new Date()) {
  const token = newToken(24);
  const prep = await withTenant(tenantId, async (trx) => {
    const d = await trx.selectFrom('gift_card_deliveries').selectAll().where('id', '=', deliveryId).where('status', '=', 'scheduled').forUpdate().skipLocked().executeTakeFirst();
    if (!d || d.send_at > now || (d.next_attempt_at && d.next_attempt_at > now)) return null;
    const card = await trx.selectFrom('gift_cards as g').leftJoin('tenant_customers as c', 'c.id', 'g.purchaser_customer_id')
      .select(['g.initial_minor', 'g.currency', 'g.status', 'c.display_name as sender']).where('g.id', '=', d.gift_card_id).executeTakeFirstOrThrow();
    if (card.status !== 'active') {
      await trx.updateTable('gift_card_deliveries').set({ status: 'cancelled', last_error: `card_${card.status}` }).where('id', '=', d.id).execute();
      return null;
    }
    const t = await trx.selectFrom('tenants').select(['name', 'slug']).where('id', '=', tenantId).executeTakeFirstOrThrow();
    const s = await trx.selectFrom('tenant_settings').select('notify_channels').where('tenant_id', '=', tenantId).executeTakeFirstOrThrow();
    await trx.updateTable('gift_card_deliveries').set({ attempts: sql`attempts + 1`, view_token_hash: viewHash(token) }).where('id', '=', d.id).execute();
    return { d, card, tenant: t, channels: s.notify_channels };
  });
  if (!prep) return null;
  const { d, card, tenant } = prep;
  const code = decryptCode(d.code_ciphertext);
  const link = `${env().APP_URL}/s/${tenant.slug}/gift/${token}`;
  const sender = (card.sender ?? '').split(' ')[0] || '';
  const amount = formatMoney(card.initial_minor, card.currency, 'ar');
  const body = [
    `${d.recipient_name}، وصلتكِ بطاقة إهداء${sender ? ` من ${sender}` : ''} بقيمة ${amount} من ${tenant.name}.`,
    d.message ? `«${d.message}»` : null,
    `رمز البطاقة: ${code}`,
    `التفاصيل والحجز: ${link}`,
  ].filter(Boolean).join('\n');
  const results: Array<{ channel: Channel; r: DeliveryResult }> = [];
  for (const c of pickChannels(d.recipient_phone, d.recipient_email, prep.channels)) {
    const r = await sendTransactional({ channel: c.channel, to: c.to, subject: `بطاقة إهداء من ${tenant.name}`, body, templateKey: 'giftcard.delivery', locale: 'ar', tenantId, dedupeKey: `giftcard:${d.id}:${d.attempts + 1}:${c.channel}` });
    results.push({ channel: c.channel, r });
  }
  const sent = results.filter((x) => x.r.status === 'sent');
  const simulated = results.filter((x) => x.r.status === 'simulated');
  const attempts = d.attempts + 1;
  return withTenant(tenantId, async (trx) => {
    if (sent.length || simulated.length) {
      const status = sent.length ? 'sent' : 'simulated';
      await trx.updateTable('gift_card_deliveries').set({ status, sent_at: now, channels: (sent.length ? sent : simulated).map((x) => x.channel), last_error: null, next_attempt_at: null })
        .where('id', '=', d.id).execute();
      await notifyUsers(trx, tenantId, [d.purchaser_user_id], {
        kind: 'giftcard.delivered', title_ar: `أُرسلت بطاقة الإهداء إلى ${d.recipient_name}`, title_en: `Your gift card was sent to ${d.recipient_name}`,
        body_ar: status === 'simulated' ? 'بيئة تجريبية: لم تُرسل رسالة حقيقية.' : undefined, body_en: status === 'simulated' ? 'Test environment: no real message was sent.' : undefined,
        dedupe_key: `giftcard.delivered:${d.id}`,
      });
      return { status };
    }
    // No provider accepted it: retry with backoff, then record the failure (never claim it was sent).
    const failed = attempts >= MAX_ATTEMPTS;
    await trx.updateTable('gift_card_deliveries').set({
      status: failed ? 'failed' : 'scheduled', last_error: 'no_provider', next_attempt_at: failed ? null : new Date(now.getTime() + 2 ** attempts * 15 * 60_000),
    }).where('id', '=', d.id).execute();
    if (failed) {
      await notifyUsers(trx, tenantId, [d.purchaser_user_id], {
        kind: 'giftcard.delivery_failed', title_ar: `تعذّر إرسال بطاقة الإهداء إلى ${d.recipient_name}`, title_en: `We could not send the gift card to ${d.recipient_name}`,
        body_ar: 'تواصلي مع النشاط لتسليمها يدوياً.', body_en: 'Please contact the business to hand it over.', dedupe_key: `giftcard.delivery_failed:${d.id}`,
      });
    }
    return { status: failed ? 'failed' : 'retry' };
  });
}

/** Periodic job: all deliveries whose send time has come. */
export async function deliverDueGiftCards(now = new Date()) {
  const due = await withSystem('find gift cards due for delivery', (trx) => trx.selectFrom('gift_card_deliveries').select(['id', 'tenant_id'])
    .where('status', '=', 'scheduled').where('send_at', '<=', now)
    .where((eb) => eb.or([eb('next_attempt_at', 'is', null), eb('next_attempt_at', '<=', now)]))
    .orderBy('send_at').limit(200).execute()) as DueDelivery[];
  const out: Array<{ id: string; status: string | null }> = [];
  for (const d of due) {
    try { out.push({ id: d.id, status: (await deliverGiftCard(d.tenant_id, d.id, now))?.status ?? null }); }
    catch (e) { console.error('[giftcards.deliver]', d.id, (e as Error).message); }
  }
  return out;
}

/** The recipient's private page: value, balance, message and her code. */
export async function giftByToken(tenantId: string, token: string) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) throw Errors.notFound('gift_card');
  return withTenant(tenantId, async (trx) => {
    const r = await trx.selectFrom('gift_card_deliveries as d').innerJoin('gift_cards as g', 'g.id', 'd.gift_card_id')
      .leftJoin('tenant_customers as c', 'c.id', 'g.purchaser_customer_id')
      .select(['d.recipient_name', 'd.message', 'd.code_ciphertext', 'g.initial_minor', 'g.balance_minor', 'g.currency', 'g.status', 'g.expires_at', 'g.template_key', 'c.display_name as sender'])
      .where('d.view_token_hash', '=', viewHash(token)).executeTakeFirst();
    if (!r) throw Errors.notFound('gift_card');
    const { code_ciphertext, sender, ...rest } = r;
    return { ...rest, sender_first_name: (sender ?? '').split(' ')[0] || null, code: r.status === 'void' ? null : decryptCode(code_ciphertext) };
  });
}
