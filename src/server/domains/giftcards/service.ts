import { sql } from 'kysely';
import { z } from 'zod';
import { withSystem, withTenant, type Tx } from '../../db/client';
import { Errors } from '../../http/errors';
import { audit, type AuditActor } from '../../infra/audit';
import { idempotent, requestHash } from '../../infra/idempotency';
import { enforce } from '../../infra/rate-limit';
import { hashToken, newHumanCode, normalizeHumanCode } from '../../auth/crypto';
import { requireFeature, type TenantAccess } from '../../tenancy/access';
import { post } from '../finance/journal';
import { applyCapturedPayment } from '../payments/service';

/**
 * Gift cards (spec §24). Codes have ~80 bits of entropy and are shown once;
 * only an HMAC of the code and its last 4 characters are stored, so reports and
 * exports never expose redemption secrets. Balances live in an append-only
 * ledger (gift_card_entries) with a cached balance guarded by CHECK >= 0.
 */
export const GIFT_TEMPLATES = ['classic', 'floral', 'minimal', 'celebration'] as const;

export const issueInput = z.object({
  amount_minor: z.number().int().min(1000).max(10_000_000),
  template_key: z.enum(GIFT_TEMPLATES).default('classic'),
  recipient_name: z.string().trim().max(80).optional(),
  recipient_contact: z.string().trim().max(120).optional(),
  message: z.string().trim().max(300).optional(),
  expires_in_days: z.number().int().min(30).max(1095).default(365),
  /** Staff issuance must say how it was paid; complimentary cards are audited as such. */
  paid: z.discriminatedUnion('method', [
    z.object({ method: z.literal('cash'), reference: z.string().trim().min(2).max(80) }),
    z.object({ method: z.literal('pos_terminal'), reference: z.string().trim().min(2).max(80) }),
    z.object({ method: z.literal('complimentary'), reason: z.string().trim().min(3).max(200) }),
  ]),
}).strict();

const hashCode = (code: string) => hashToken(normalizeHumanCode(code), 'giftcard');

async function entry(trx: Tx, tenantId: string, cardId: string, kind: 'issue' | 'redeem' | 'refund' | 'expire' | 'void' | 'adjust', delta: number, ref: { type?: string; id?: string | null } = {}, by: string | null = null) {
  const card = await trx.selectFrom('gift_cards').select(['balance_minor']).where('id', '=', cardId).forUpdate().executeTakeFirstOrThrow();
  const after = card.balance_minor + delta;
  if (after < 0) throw Errors.invalid('insufficient_gift_balance', 'Not enough balance on this gift card');
  const ins = await trx.insertInto('gift_card_entries').values({ tenant_id: tenantId, gift_card_id: cardId, kind, delta_minor: delta, balance_after_minor: after, ref_type: ref.type ?? null, ref_id: ref.id ?? null, created_by: by })
    .onConflict((oc) => oc.columns(['gift_card_id', 'kind', 'ref_type', 'ref_id']).where('ref_id', 'is not', null).doNothing()).returning('id').executeTakeFirst();
  if (!ins) return false;
  await trx.updateTable('gift_cards').set({ balance_minor: after, status: after === 0 && kind === 'redeem' ? 'redeemed' : undefined }).where('id', '=', cardId).execute();
  return true;
}

/** Staff issuance (giftcards.manage). Returns the code exactly once. */
export async function issueGiftCard(access: TenantAccess, actor: AuditActor, input: z.infer<typeof issueInput>, idempotencyKey: string) {
  requireFeature(access, 'feature.gift_cards');
  return withTenant(access.tenantId, (trx) => idempotent(trx, { scope: `tenant:${access.tenantId}`, operation: 'giftcard.issue', key: idempotencyKey, hash: requestHash(input) }, async () => {
    const code = newHumanCode();
    const card = await trx.insertInto('gift_cards').values({
      tenant_id: access.tenantId, code_hash: hashCode(code), code_last4: normalizeHumanCode(code).slice(-4), initial_minor: input.amount_minor, balance_minor: 0,
      status: 'active', template_key: input.template_key, recipient_name: input.recipient_name ?? null, recipient_contact: input.recipient_contact ?? null,
      message: input.message ?? null, issued_by: actor.userId, activated_at: new Date(), expires_at: new Date(Date.now() + input.expires_in_days * 86_400_000),
    }).returning(['id']).executeTakeFirstOrThrow();
    await entry(trx, access.tenantId, card.id, 'issue', input.amount_minor, { type: 'issue', id: card.id }, actor.userId);
    if (input.paid.method !== 'complimentary') {
      await post(trx, access.tenantId, { type: 'gift_card_sale', id: card.id }, [
        { account: input.paid.method === 'cash' ? 'cash_on_hand' : 'provider_clearing', debit: input.amount_minor }, { account: 'gift_card_liability', credit: input.amount_minor },
      ], { createdBy: actor.userId, memo: `gift card sold (${input.paid.reference})` });
    } else {
      await post(trx, access.tenantId, { type: 'gift_card_comp', id: card.id }, [{ account: 'discounts', debit: input.amount_minor }, { account: 'gift_card_liability', credit: input.amount_minor }], { createdBy: actor.userId, memo: `complimentary: ${input.paid.reason}` });
    }
    await audit(trx, actor, 'giftcard.issued', { tenantId: access.tenantId, targetType: 'gift_card', targetId: card.id, data: { amount_minor: input.amount_minor, paid: input.paid.method, last4: normalizeHumanCode(code).slice(-4) } });
    return { status: 201, body: { id: card.id, code, last4: normalizeHumanCode(code).slice(-4), amount_minor: input.amount_minor, template_key: input.template_key } };
  }));
}

export async function listGiftCards(access: TenantAccess) {
  requireFeature(access, 'feature.gift_cards');
  return withTenant(access.tenantId, (trx) => trx.selectFrom('gift_cards')
    .select(['id', 'code_last4', 'initial_minor', 'balance_minor', 'status', 'template_key', 'recipient_name', 'expires_at', 'created_at'])
    .orderBy('created_at', 'desc').limit(300).execute());
}

/** Balance lookup by code — rate-limited; reveals only the balance and expiry. */
export async function checkBalance(tenantId: string, code: string, rateKey: string) {
  await enforce(`giftcard:check:${rateKey}`, 10, 900);
  return withTenant(tenantId, async (trx) => {
    const c = await trx.selectFrom('gift_cards').select(['balance_minor', 'currency', 'status', 'expires_at', 'code_last4']).where('code_hash', '=', hashCode(code)).executeTakeFirst();
    if (!c || c.status === 'void' || c.status === 'pending') throw Errors.notFound('gift_card');
    return c;
  });
}

/**
 * Partial redemption against a booking or order balance. Creates a captured
 * payment (method gift_card) so the booking/order accounting is unchanged,
 * and a ledger entry on the card — both exactly once per idempotency key.
 */
export async function redeemGiftCard(tenantId: string, input: { code: string; bookingId?: string; orderId?: string; amountMinor: number; actorUserId: string; idempotencyKey: string; rateKey: string; payerUserId?: string | null }) {
  await enforce(`giftcard:redeem:${input.rateKey}`, 10, 900);
  if (!!input.bookingId === !!input.orderId) throw Errors.invalid('invalid_target');
  return withTenant(tenantId, (trx) => idempotent(trx, { scope: `tenant:${tenantId}:user:${input.actorUserId}`, operation: 'giftcard.redeem', key: input.idempotencyKey, hash: requestHash({ ...input, code: normalizeHumanCode(input.code) }) }, async () => {
    const card = await trx.selectFrom('gift_cards').selectAll().where('code_hash', '=', hashCode(input.code)).forUpdate().executeTakeFirst();
    if (!card || card.status !== 'active') throw Errors.notFound('gift_card');
    if (card.expires_at && card.expires_at <= new Date()) throw Errors.invalid('gift_card_expired');
    let due: number;
    if (input.bookingId) {
      const b = await trx.selectFrom('bookings').select(['total_minor', 'paid_minor', 'status', 'customer_user_id']).where('id', '=', input.bookingId).forUpdate().executeTakeFirst();
      if (!b || ['cancelled', 'expired'].includes(b.status)) throw Errors.notFound('booking');
      if (input.payerUserId && b.customer_user_id !== input.payerUserId) throw Errors.notFound('booking');
      due = b.total_minor - b.paid_minor;
    } else {
      const o = await trx.selectFrom('orders').select(['total_minor', 'paid_minor', 'status', 'customer_user_id']).where('id', '=', input.orderId!).forUpdate().executeTakeFirst();
      if (!o || o.status === 'cancelled') throw Errors.notFound('order');
      if (input.payerUserId && o.customer_user_id !== input.payerUserId) throw Errors.notFound('order');
      due = o.total_minor - o.paid_minor;
    }
    const amount = Math.min(input.amountMinor, due, card.balance_minor);
    if (amount <= 0) throw Errors.invalid('nothing_to_redeem');
    const p = await trx.insertInto('payments').values({
      tenant_id: tenantId, purpose: input.bookingId ? 'booking' : 'order', booking_id: input.bookingId ?? null, order_id: input.orderId ?? null,
      kind: 'balance', method: 'gift_card', amount_minor: amount, currency: card.currency, status: 'captured', provider: 'gift_card',
      provider_payment_id: `gc:${card.id}:${input.idempotencyKey}`, idempotency_key: `giftcard:${input.idempotencyKey}`, captured_at: new Date(), created_by: input.actorUserId, payer_user_id: input.payerUserId ?? null,
    }).returning('id').executeTakeFirstOrThrow();
    await entry(trx, tenantId, card.id, 'redeem', -amount, { type: 'payment', id: p.id }, input.actorUserId);
    await applyCapturedPayment(trx, tenantId, p.id, input.actorUserId);
    return { status: 201, body: { payment_id: p.id, redeemed_minor: amount, remaining_minor: card.balance_minor - amount } };
  }));
}

/** Refunding a gift-card payment restores the card balance (never cash). */
export async function restoreOnRefund(trx: Tx, tenantId: string, refundId: string) {
  const r = await trx.selectFrom('refunds as r').innerJoin('payments as p', 'p.id', 'r.payment_id').select(['r.amount_minor', 'p.method', 'p.provider_payment_id']).where('r.id', '=', refundId).executeTakeFirst();
  if (!r || r.method !== 'gift_card' || !r.provider_payment_id) return;
  const cardId = r.provider_payment_id.split(':')[1]!;
  await entry(trx, tenantId, cardId, 'refund', r.amount_minor, { type: 'refund', id: refundId });
  await trx.updateTable('gift_cards').set({ status: 'active' }).where('id', '=', cardId).where('status', '=', 'redeemed').execute();
}

export async function voidGiftCard(access: TenantAccess, actor: AuditActor, cardId: string, reason: string) {
  return withTenant(access.tenantId, async (trx) => {
    const c = await trx.selectFrom('gift_cards').select(['balance_minor', 'status']).where('id', '=', cardId).forUpdate().executeTakeFirst();
    if (!c) throw Errors.notFound('gift_card');
    if (c.status === 'void') throw Errors.conflict('already_void');
    if (c.balance_minor > 0) {
      await entry(trx, access.tenantId, cardId, 'void', -c.balance_minor, { type: 'void', id: cardId }, actor.userId);
      await post(trx, access.tenantId, { type: 'gift_card_void', id: cardId }, [{ account: 'gift_card_liability', debit: c.balance_minor }, { account: 'discounts', credit: c.balance_minor }], { createdBy: actor.userId, memo: reason });
    }
    await trx.updateTable('gift_cards').set({ status: 'void' }).where('id', '=', cardId).execute();
    await audit(trx, actor, 'giftcard.voided', { tenantId: access.tenantId, targetType: 'gift_card', targetId: cardId, data: { reason } });
    return { id: cardId, status: 'void' };
  });
}

/** Expiry: remaining balance is released from the liability (breakage), recorded in the ledger. */
export async function expireGiftCards() {
  const due = await withSystem('find expired gift cards', (trx) => trx.selectFrom('gift_cards').select(['id', 'tenant_id', 'balance_minor'])
    .where('status', '=', 'active').where('expires_at', '<=', new Date()).limit(500).execute());
  for (const d of due) {
    await withTenant(d.tenant_id, async (trx) => {
      if (d.balance_minor > 0) {
        const done = await entry(trx, d.tenant_id, d.id, 'expire', -d.balance_minor, { type: 'expiry', id: d.id });
        if (done) await post(trx, d.tenant_id, { type: 'gift_card_expiry', id: d.id }, [{ account: 'gift_card_liability', debit: d.balance_minor }, { account: 'service_revenue', credit: d.balance_minor }], { memo: 'gift card breakage (expired balance)' });
      }
      await trx.updateTable('gift_cards').set({ status: 'expired' }).where('id', '=', d.id).execute();
    });
  }
  return due.length;
}

void sql;
