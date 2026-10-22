import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { sql } from 'kysely';
import { db } from '../../../db/client';
import { env } from '../../../env';
import { WebhookVerificationError, type CreateCheckout, type PaymentProvider, type VerifiedEvent } from './types';

const TOLERANCE_SEC = 300;

function secret() {
  const s = env().PAYMENT_SANDBOX_WEBHOOK_SECRET;
  if (!s || s.length < 16) throw new Error('PAYMENT_SANDBOX_WEBHOOK_SECRET is not configured');
  return s;
}

export function signSandbox(body: string, ts: number) {
  return createHmac('sha256', secret()).update(`${ts}.${body}`).digest('hex');
}

/**
 * LUMA Sandbox — a SIMULATED provider for private review and tests.
 * Hosted "checkout" is a LUMA page clearly labelled as a simulation; it moves
 * no money. Webhooks are HMAC-signed with a timestamp like a real provider's.
 */
export const sandboxProvider: PaymentProvider = {
  name: 'sandbox',
  supportedMethods: ['sandbox'],
  isSimulation: true,

  async createCheckout(req: CreateCheckout) {
    const id = `sbx_${randomUUID().replace(/-/g, '')}`;
    await db().insertInto('sandbox_provider_payments').values({
      id, account_ref: req.accountRef, amount_minor: req.amountMinor, currency: req.currency, status: 'initiated', metadata: JSON.stringify(req.metadata),
    }).execute();
    return { providerPaymentId: id, checkoutUrl: `/sandbox/checkout/${id}?return=${encodeURIComponent(req.returnUrl)}` };
  },

  async refund(req) {
    const p = await db().selectFrom('sandbox_provider_payments').selectAll().where('id', '=', req.providerPaymentId).executeTakeFirst();
    if (!p || p.status !== 'captured') return { providerRefundId: `sbx_rf_${randomUUID().slice(0, 8)}`, status: 'failed' as const };
    if (p.refunded_minor + req.amountMinor > p.amount_minor) return { providerRefundId: `sbx_rf_${randomUUID().slice(0, 8)}`, status: 'failed' as const };
    const id = `sbx_rf_${randomUUID().replace(/-/g, '')}`;
    await db().insertInto('sandbox_provider_refunds').values({ id, payment_id: p.id, amount_minor: req.amountMinor, status: 'pending' }).execute();
    return { providerRefundId: id, status: 'pending' as const };
  },

  verifyWebhook(rawBody: string, headers: Headers, now = new Date()): VerifiedEvent {
    const header = headers.get('x-sandbox-signature') ?? '';
    const parts = Object.fromEntries(header.split(',').map((kv) => kv.split('=') as [string, string]));
    const ts = Number(parts.t);
    if (!ts || !parts.v1) throw new WebhookVerificationError('missing signature');
    if (Math.abs(now.getTime() / 1000 - ts) > TOLERANCE_SEC) throw new WebhookVerificationError('timestamp outside tolerance');
    const expected = Buffer.from(signSandbox(rawBody, ts), 'hex');
    const given = Buffer.from(parts.v1, 'hex');
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw new WebhookVerificationError('bad signature');
    let body: any;
    try { body = JSON.parse(rawBody); } catch { throw new WebhookVerificationError('invalid body'); }
    const d = body?.data ?? {};
    if (typeof body?.id !== 'string' || typeof body?.type !== 'string' || typeof d.payment_id !== 'string' || !Number.isSafeInteger(d.amount) || typeof d.currency !== 'string' || typeof d.account !== 'string') {
      throw new WebhookVerificationError('invalid event shape');
    }
    const types = ['payment.captured', 'payment.failed', 'payment.cancelled', 'refund.succeeded', 'refund.failed'];
    if (!types.includes(body.type)) throw new WebhookVerificationError('unknown event type');
    return {
      eventId: body.id, type: body.type, createdAt: new Date((body.created ?? ts) * 1000), providerPaymentId: d.payment_id,
      providerRefundId: d.refund_id, amountMinor: d.amount, currency: d.currency, accountRef: d.account, raw: body,
    };
  },

  async fetchPayment(id) {
    const p = await db().selectFrom('sandbox_provider_payments').selectAll().where('id', '=', id).executeTakeFirst();
    if (!p) return null;
    return { status: p.status, amountMinor: p.amount_minor, currency: p.currency, refundedMinor: p.refunded_minor };
  },
};

/** Simulates the provider completing a hosted checkout and returns the signed webhook it would send. */
export async function simulateSandboxOutcome(providerPaymentId: string, outcome: 'captured' | 'failed' | 'cancelled') {
  const p = await db().selectFrom('sandbox_provider_payments').selectAll().where('id', '=', providerPaymentId).executeTakeFirst();
  if (!p) return null;
  if (p.status === 'initiated') {
    await db().updateTable('sandbox_provider_payments').set({ status: outcome, updated_at: new Date() }).where('id', '=', p.id).execute();
  }
  const finalStatus = p.status === 'initiated' ? outcome : p.status;
  return buildSandboxEvent(`payment.${finalStatus === 'initiated' ? 'failed' : finalStatus}`, { payment_id: p.id, amount: p.amount_minor, currency: p.currency, account: p.account_ref });
}

export async function simulateSandboxRefund(providerRefundId: string, outcome: 'succeeded' | 'failed' = 'succeeded') {
  const r = await db().selectFrom('sandbox_provider_refunds').selectAll().where('id', '=', providerRefundId).executeTakeFirst();
  if (!r) return null;
  const p = await db().selectFrom('sandbox_provider_payments').selectAll().where('id', '=', r.payment_id).executeTakeFirstOrThrow();
  if (r.status === 'pending') {
    await db().updateTable('sandbox_provider_refunds').set({ status: outcome }).where('id', '=', r.id).execute();
    if (outcome === 'succeeded') await db().updateTable('sandbox_provider_payments').set({ refunded_minor: sql`refunded_minor + ${r.amount_minor}` }).where('id', '=', p.id).execute();
  }
  return buildSandboxEvent(`refund.${outcome}`, { payment_id: p.id, refund_id: r.id, amount: r.amount_minor, currency: p.currency, account: p.account_ref });
}

export function buildSandboxEvent(type: string, data: Record<string, unknown>, opts: { id?: string; ts?: number } = {}) {
  const ts = opts.ts ?? Math.floor(Date.now() / 1000);
  const body = JSON.stringify({ id: opts.id ?? `evt_${randomUUID().replace(/-/g, '')}`, type, created: ts, data });
  return { body, headers: { 'x-sandbox-signature': `t=${ts},v1=${signSandbox(body, ts)}` } };
}
