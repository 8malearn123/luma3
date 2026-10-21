import { sql } from 'kysely';
import { db, withSystem, withTenant, type Tx } from '../../db/client';
import { env } from '../../env';
import { AppError, Errors } from '../../http/errors';
import { audit, type AuditActor } from '../../infra/audit';
import { idempotent, requestHash } from '../../infra/idempotency';
import { notifyCapability, notifyUsers } from '../../infra/notify';
import { hasCapability, type TenantAccess } from '../../tenancy/access';
import { applyHoldOutcome, enabledMethods, tryReallocateExpired } from '../booking/service';
import { computePaymentTerms } from '../booking/terms';
import { post, splitTax } from '../finance/journal';
import { provider } from './providers/registry';
import { WebhookVerificationError, type VerifiedEvent } from './providers/types';
import { paymentTargets } from './targets';
import type { PaymentOption, PaymentTerms } from '@/shared/payments';

// ── Accounts ────────────────────────────────────────────────────────────────
export async function activeAccount(trx: Tx, tenantId: string) {
  return trx.selectFrom('payment_accounts').selectAll().where('tenant_id', '=', tenantId).where('status', '=', 'active').orderBy('created_at').executeTakeFirst();
}

/** Connects the LUMA Sandbox (test mode). Real providers are not integrated; see providers/registry.ts. */
export async function connectSandbox(access: TenantAccess, actor: AuditActor) {
  return withTenant(access.tenantId, async (trx) => {
    const row = await trx.insertInto('payment_accounts').values({
      tenant_id: access.tenantId, provider: 'sandbox', mode: 'test', status: 'active', enabled_methods: ['sandbox'], merchant_ref: `sbx_acct_${access.tenantId.slice(0, 8)}`,
    }).onConflict((oc) => oc.columns(['tenant_id', 'provider', 'mode']).doUpdateSet({ status: 'active' })).returningAll().executeTakeFirstOrThrow();
    await audit(trx, actor, 'payments.account_connected', { tenantId: access.tenantId, targetType: 'payment_account', targetId: row.id, data: { provider: 'sandbox', mode: 'test' } });
    return row;
  });
}

export async function disconnectAccount(access: TenantAccess, actor: AuditActor, accountId: string) {
  return withTenant(access.tenantId, async (trx) => {
    const r = await trx.updateTable('payment_accounts').set({ status: 'disconnected' }).where('id', '=', accountId).returning('id').executeTakeFirst();
    if (!r) throw Errors.notFound('payment_account');
    await audit(trx, actor, 'payments.account_disconnected', { tenantId: access.tenantId, targetType: 'payment_account', targetId: accountId });
    return r;
  });
}

// ── Checkout (customer) ─────────────────────────────────────────────────────
function materialChange(a: PaymentTerms, b: PaymentTerms) {
  return a.amountDueMinor !== b.amountDueMinor || a.depositMinor !== b.depositMinor || a.blocked !== b.blocked
    || a.requiresManualApproval !== b.requiresManualApproval || a.allowed.slice().sort().join() !== b.allowed.slice().sort().join();
}

/**
 * Customer checkout for a held booking. The browser only chooses an option;
 * the amount, currency, beneficiary account and allowed options are computed
 * on the server. Terms are re-assessed: if they changed materially since the
 * hold (e.g. a new policy decision), the customer must re-confirm (409).
 */
export type CheckoutBody = { booking_id: string; status: string; payment: { id: string; checkout_url: string; amount_minor: number; simulation: boolean } | null };

export async function checkoutBooking(tenantId: string, bookingId: string, input: { option: PaymentOption; userId: string; idempotencyKey: string; returnUrl: string; actor: AuditActor; acceptTerms?: PaymentTerms | null }) {
  const scope = `tenant:${tenantId}:user:${input.userId}`;
  return withTenant(tenantId, (trx) => idempotent(trx, { scope, operation: 'checkout.booking', key: input.idempotencyKey, hash: requestHash({ bookingId, option: input.option }) }, async (): Promise<{ status: number; body: CheckoutBody }> => {
    const b = await trx.selectFrom('bookings').selectAll().where('id', '=', bookingId).forUpdate().executeTakeFirst();
    if (!b || b.customer_user_id !== input.userId) throw Errors.notFound('booking');
    if (b.status !== 'held') throw Errors.conflict('invalid_transition', `Booking is ${b.status}`);
    if (!b.hold_expires_at || b.hold_expires_at <= new Date()) throw Errors.conflict('hold_expired', 'The reserved time expired. Please choose a time again.');
    const snapshot = b.payment_terms as unknown as PaymentTerms;
    const methods = await enabledMethods(trx, tenantId);
    const fresh = await computePaymentTerms(trx, { tenantId, tenantCustomerId: b.tenant_customer_id, customerUserId: b.customer_user_id, amountDueMinor: b.total_minor - b.paid_minor, availableMethods: methods, context: 'booking' });
    if (materialChange(snapshot, fresh)) {
      await trx.updateTable('bookings').set({ payment_terms: JSON.stringify({ ...fresh, requiresManualApproval: fresh.requiresManualApproval || snapshot.requiresManualApproval }), deposit_due_minor: fresh.depositMinor ?? 0 }).where('id', '=', bookingId).execute();
      throw Errors.conflict('terms_changed', 'The payment terms for this booking changed. Please review them.', { terms: fresh });
    }
    const terms = { ...fresh, requiresManualApproval: fresh.requiresManualApproval || snapshot.requiresManualApproval };
    if (terms.blocked) throw Errors.invalid('payment_blocked', 'This booking cannot be paid online right now. Please contact the business.', { explanation: terms.customerExplanation });
    // The restriction is enforced here regardless of what the browser shows.
    if (!terms.allowed.includes(input.option)) throw Errors.invalid('payment_option_not_allowed', 'This payment option is not available for this booking', { allowed: terms.allowed });

    if (input.option === 'on_site' || b.total_minor === 0) {
      const out = await applyHoldOutcome(trx, tenantId, bookingId, terms.requiresManualApproval ? 'pending_approval' : 'confirmed', { userId: input.userId, source: 'customer', reason: 'pay_on_site' });
      return { status: 200, body: { booking_id: bookingId, status: out.status, payment: null } };
    }
    const amount = input.option === 'deposit' ? terms.depositMinor! : b.total_minor - b.paid_minor;
    if (!(amount > 0) || amount > b.total_minor - b.paid_minor) throw Errors.invalid('invalid_amount');
    const acct = await activeAccount(trx, tenantId);
    const p = acct ? provider(acct.provider) : null;
    if (!acct || !p) throw Errors.unavailable('payments_unavailable', 'Online payment is not set up for this business');
    const payment = await createProviderPayment(trx, {
      tenantId, account: acct, purpose: 'booking', bookingId, kind: input.option === 'deposit' ? 'deposit' : 'full', amountMinor: amount, currency: b.currency,
      payerUserId: input.userId, idempotencyKey: `booking:${bookingId}:${input.idempotencyKey}`, description: `Booking ${b.number}`, returnUrl: input.returnUrl,
      expiresAt: b.hold_expires_at,
    });
    await applyHoldOutcome(trx, tenantId, bookingId, 'pending_payment', { userId: input.userId, source: 'customer', reason: `online_${input.option}` });
    await audit(trx, input.actor, 'checkout.booking_payment_created', { tenantId, targetType: 'payment', targetId: payment.id, data: { amount_minor: amount, option: input.option } });
    return { status: 201, body: { booking_id: bookingId, status: 'pending_payment', payment: { id: payment.id, checkout_url: payment.checkoutUrl, amount_minor: amount, simulation: p.isSimulation } } };
  }));
}

/** Customer checkout for a pending order (full online payment). */
export async function checkoutOrder(tenantId: string, orderId: string, input: { userId: string; idempotencyKey: string; returnUrl: string; actor: AuditActor }) {
  const scope = `tenant:${tenantId}:user:${input.userId}`;
  return withTenant(tenantId, (trx) => idempotent(trx, { scope, operation: 'checkout.order', key: input.idempotencyKey, hash: requestHash({ orderId }) }, async () => {
    const o = await trx.selectFrom('orders').selectAll().where('id', '=', orderId).forUpdate().executeTakeFirst();
    if (!o || o.customer_user_id !== input.userId) throw Errors.notFound('order');
    if (o.status !== 'pending_payment') throw Errors.conflict('invalid_transition', `Order is ${o.status}`);
    if (o.expires_at && o.expires_at <= new Date()) throw Errors.conflict('order_expired', 'This order expired. Please check out again.');
    const terms = await computePaymentTerms(trx, { tenantId, tenantCustomerId: o.tenant_customer_id, customerUserId: o.customer_user_id, amountDueMinor: o.total_minor - o.paid_minor, availableMethods: await enabledMethods(trx, tenantId), context: 'order' });
    if (terms.blocked || !terms.allowed.includes('full')) throw Errors.invalid('payment_blocked', 'This order cannot be paid online right now. Please contact the business.', { explanation: terms.customerExplanation });
    const acct = await activeAccount(trx, tenantId);
    const p = acct ? provider(acct.provider) : null;
    if (!acct || !p) throw Errors.unavailable('payments_unavailable', 'Online payment is not set up for this business');
    const payment = await createProviderPayment(trx, {
      tenantId, account: acct, purpose: 'order', orderId, kind: 'full', amountMinor: o.total_minor - o.paid_minor, currency: o.currency, payerUserId: input.userId,
      idempotencyKey: `order:${orderId}:${input.idempotencyKey}`, description: `Order ${o.number}`, returnUrl: input.returnUrl, expiresAt: o.expires_at,
    });
    await trx.updateTable('orders').set({ payment_terms: JSON.stringify(terms) }).where('id', '=', orderId).execute();
    return { status: 201, body: { order_id: orderId, payment: { id: payment.id, checkout_url: payment.checkoutUrl, amount_minor: o.total_minor - o.paid_minor, simulation: p.isSimulation } } };
  }));
}

type Account = NonNullable<Awaited<ReturnType<typeof activeAccount>>>;

async function createProviderPayment(trx: Tx, a: {
  tenantId: string; account: Account; purpose: 'booking' | 'order' | 'gift_card' | 'membership'; bookingId?: string; orderId?: string; giftCardId?: string; membershipId?: string;
  kind: 'full' | 'deposit' | 'balance'; amountMinor: number; currency: string; payerUserId: string | null; idempotencyKey: string; description: string; returnUrl: string; expiresAt: Date | null;
}) {
  const p = provider(a.account.provider)!;
  const row = await trx.insertInto('payments').values({
    tenant_id: a.tenantId, payment_account_id: a.account.id, purpose: a.purpose, booking_id: a.bookingId ?? null, order_id: a.orderId ?? null,
    gift_card_id: a.giftCardId ?? null, customer_membership_id: a.membershipId ?? null, kind: a.kind, method: 'sandbox',
    amount_minor: a.amountMinor, currency: a.currency, status: 'pending', provider: a.account.provider, idempotency_key: a.idempotencyKey,
    payer_user_id: a.payerUserId, expires_at: a.expiresAt, created_by: a.payerUserId,
  }).returning('id').executeTakeFirstOrThrow();
  const co = await p.createCheckout({
    paymentId: row.id, amountMinor: a.amountMinor, currency: a.currency, accountRef: a.account.merchant_ref ?? a.account.id, description: a.description,
    returnUrl: a.returnUrl, metadata: { luma_payment_id: row.id, tenant_id: a.tenantId },
  });
  await trx.updateTable('payments').set({ provider_payment_id: co.providerPaymentId, checkout_url: co.checkoutUrl, status: 'requires_action' }).where('id', '=', row.id).execute();
  await trx.insertInto('payment_attempts').values({ tenant_id: a.tenantId, payment_id: row.id, provider: a.account.provider, status: 'redirected', provider_ref: co.providerPaymentId, checkout_url: co.checkoutUrl }).execute();
  return { id: row.id, checkoutUrl: co.checkoutUrl, providerPaymentId: co.providerPaymentId };
}

/** Payment status for the payer (never trusts a browser redirect as proof of payment). */
export async function paymentStatusForPayer(tenantId: string, paymentId: string, userId: string) {
  return withTenant(tenantId, async (trx) => {
    const p = await trx.selectFrom('payments').select(['id', 'status', 'amount_minor', 'currency', 'booking_id', 'order_id', 'needs_reconciliation', 'payer_user_id']).where('id', '=', paymentId).executeTakeFirst();
    if (!p || p.payer_user_id !== userId) throw Errors.notFound('payment');
    let target: { status: string; payment_status?: string } | null = null;
    if (p.booking_id) target = await trx.selectFrom('bookings').select(['status', 'payment_status']).where('id', '=', p.booking_id).executeTakeFirst() ?? null;
    if (p.order_id) target = await trx.selectFrom('orders').select(['status']).where('id', '=', p.order_id).executeTakeFirst() ?? null;
    const { payer_user_id: _p, ...rest } = p;
    return { ...rest, target };
  });
}

// ── On-site collection (reception) ──────────────────────────────────────────
/** Cash/terminal collection requires the payments.collect capability, the collector's identity and a reference. */
export async function recordOnSitePayment(access: TenantAccess, actor: AuditActor, input: { bookingId?: string; orderId?: string; amountMinor: number; method: 'cash' | 'pos_terminal'; reference: string; idempotencyKey: string }) {
  if (!actor.userId) throw Errors.unauthenticated();
  if (!!input.bookingId === !!input.orderId) throw Errors.invalid('invalid_target');
  if (!(input.amountMinor > 0)) throw Errors.invalid('invalid_amount');
  return withTenant(access.tenantId, (trx) => idempotent(trx, { scope: `tenant:${access.tenantId}`, operation: 'payment.on_site', key: input.idempotencyKey, hash: requestHash(input) }, async () => {
    let due: number;
    let currency = 'SAR';
    if (input.bookingId) {
      const b = await trx.selectFrom('bookings').selectAll().where('id', '=', input.bookingId).forUpdate().executeTakeFirst();
      if (!b) throw Errors.notFound('booking');
      if (['cancelled', 'expired'].includes(b.status)) throw Errors.conflict('invalid_transition', `Booking is ${b.status}`);
      due = b.total_minor - b.paid_minor; currency = b.currency;
    } else {
      const o = await trx.selectFrom('orders').selectAll().where('id', '=', input.orderId!).forUpdate().executeTakeFirst();
      if (!o) throw Errors.notFound('order');
      if (o.status === 'cancelled') throw Errors.conflict('invalid_transition');
      due = o.total_minor - o.paid_minor; currency = o.currency;
    }
    if (input.amountMinor > due) throw Errors.invalid('amount_exceeds_due', 'Amount exceeds the balance due', { due_minor: due });
    const p = await trx.insertInto('payments').values({
      tenant_id: access.tenantId, purpose: input.bookingId ? 'booking' : 'order', booking_id: input.bookingId ?? null, order_id: input.orderId ?? null,
      kind: 'on_site', method: input.method, amount_minor: input.amountMinor, currency,
      status: 'captured', provider: 'on_site', idempotency_key: `onsite:${input.idempotencyKey}`, collected_by: actor.userId, cash_reference: input.reference,
      captured_at: new Date(), created_by: actor.userId,
    }).returning('id').executeTakeFirstOrThrow();
    await applyCaptured(trx, access.tenantId, p.id, actor.userId);
    await audit(trx, actor, 'payment.on_site_collected', { tenantId: access.tenantId, targetType: 'payment', targetId: p.id, data: { amount_minor: input.amountMinor, method: input.method, reference: input.reference } });
    return { status: 201, body: { payment_id: p.id } };
  }));
}

// ── Capture application (shared by webhooks and on-site) ────────────────────
/**
 * Applies a captured payment to its target exactly once (guarded by the
 * payment row lock and status). Booking: paid amount, financial status,
 * confirmation (or late-success handling). Order: delegated to commerce.
 */
export async function applyCapturedPayment(trx: Tx, tenantId: string, paymentId: string, actorUserId: string | null) {
  return applyCaptured(trx, tenantId, paymentId, actorUserId);
}

const ledgerAccount = (method: string) => (method === 'cash' ? 'cash_on_hand' : method === 'gift_card' ? 'gift_card_liability' : 'provider_clearing') as 'cash_on_hand' | 'gift_card_liability' | 'provider_clearing';

async function applyCaptured(trx: Tx, tenantId: string, paymentId: string, actorUserId: string | null) {
  const p = await trx.selectFrom('payments').selectAll().where('id', '=', paymentId).forUpdate().executeTakeFirstOrThrow();
  const cashAccount = ledgerAccount(p.method);
  if (p.booking_id) {
    const b = await trx.selectFrom('bookings').selectAll().where('id', '=', p.booking_id).forUpdate().executeTakeFirstOrThrow();
    const paid = b.paid_minor + p.amount_minor;
    const paymentStatus = paid >= b.total_minor ? 'paid' : p.kind === 'deposit' ? 'deposit_paid' : 'partially_paid';
    await trx.updateTable('bookings').set({ paid_minor: paid, payment_status: paymentStatus }).where('id', '=', b.id).execute();
    // Before service completion the money is a customer deposit (liability), not revenue.
    const recognised = b.status === 'completed';
    await post(trx, tenantId, { type: 'payment', id: p.id }, [
      { account: cashAccount, debit: p.amount_minor },
      { account: recognised ? 'accounts_receivable' : 'customer_deposits', credit: p.amount_minor },
    ], { createdBy: actorUserId, memo: `payment ${b.number}` });

    if (b.status === 'pending_payment' || b.status === 'held') {
      const terms = b.payment_terms as { requiresManualApproval?: boolean };
      try {
        await applyHoldOutcome(trx, tenantId, b.id, terms.requiresManualApproval ? 'pending_approval' : 'confirmed', { userId: actorUserId, source: 'payment', reason: 'payment_captured' });
      } catch (e) {
        if (!(e instanceof AppError && e.code === 'hold_expired')) throw e;
        await lateSuccess(trx, tenantId, p.id, b.id);
      }
    } else if (b.status === 'expired') {
      await lateSuccess(trx, tenantId, p.id, b.id);
    } else if (b.status === 'cancelled' || b.status === 'no_show') {
      // Paid after the booking ended: never silently keep it.
      await flagReconciliation(trx, tenantId, p.id, 'captured_after_booking_closed');
      await requestRefundInternal(trx, tenantId, { paymentId: p.id, amountMinor: p.amount_minor, reason: 'captured_after_booking_closed', basis: { auto: true }, idempotencyKey: `auto-closed:${p.id}`, system: true });
    }
  } else if (p.order_id) {
    await paymentTargets.order.onCaptured(trx, tenantId, p.order_id, { paymentId: p.id, amountMinor: p.amount_minor });
    const o = await trx.selectFrom('orders').select(['tax_minor', 'total_minor', 'number', 'status']).where('id', '=', p.order_id).executeTakeFirstOrThrow();
    const { net, tax } = splitTax(p.amount_minor, o.tax_minor, o.total_minor);
    await post(trx, tenantId, { type: 'payment', id: p.id }, [
      { account: cashAccount, debit: p.amount_minor }, { account: 'product_revenue', credit: net }, { account: 'tax_payable', credit: tax },
    ], { createdBy: actorUserId, memo: `order ${o.number}` });
    if (o.status === 'cancelled') {
      await flagReconciliation(trx, tenantId, p.id, 'captured_after_order_cancelled');
      await requestRefundInternal(trx, tenantId, { paymentId: p.id, amountMinor: p.amount_minor, reason: 'captured_after_order_cancelled', basis: { auto: true }, idempotencyKey: `auto-order:${p.id}`, system: true });
    }
  } else if (p.gift_card_id) {
    await paymentTargets.giftCard.onCaptured(trx, tenantId, p.gift_card_id, { paymentId: p.id, amountMinor: p.amount_minor });
    await post(trx, tenantId, { type: 'payment', id: p.id }, [{ account: cashAccount, debit: p.amount_minor }, { account: 'gift_card_liability', credit: p.amount_minor }], { createdBy: actorUserId });
  } else if (p.customer_membership_id) {
    await paymentTargets.membership.onCaptured(trx, tenantId, p.customer_membership_id, { paymentId: p.id, amountMinor: p.amount_minor });
    await post(trx, tenantId, { type: 'payment', id: p.id }, [{ account: cashAccount, debit: p.amount_minor }, { account: 'membership_liability', credit: p.amount_minor }], { createdBy: actorUserId });
  }
}

/** Payment succeeded after the hold expired: re-confirm only if the same slot is still free; otherwise refund. */
async function lateSuccess(trx: Tx, tenantId: string, paymentId: string, bookingId: string) {
  const ok = await tryReallocateExpired(trx, tenantId, bookingId);
  if (ok) return;
  await flagReconciliation(trx, tenantId, paymentId, 'late_success_slot_taken');
  await trx.updateTable('bookings').set({ status: 'cancelled', cancelled_at: new Date(), cancel_source: 'system', cancel_reason: 'payment_after_hold_expired_slot_taken' })
    .where('id', '=', bookingId).where('status', 'in', ['expired', 'held', 'pending_payment']).execute();
  await trx.insertInto('booking_events').values({ tenant_id: tenantId, booking_id: bookingId, from_status: 'expired', to_status: 'cancelled', source: 'system', reason: 'late_payment_slot_taken' }).execute();
  const p = await trx.selectFrom('payments').select(['amount_minor', 'payer_user_id']).where('id', '=', paymentId).executeTakeFirstOrThrow();
  await requestRefundInternal(trx, tenantId, { paymentId, amountMinor: p.amount_minor, reason: 'late_payment_slot_taken', basis: { auto: true }, idempotencyKey: `auto-late:${paymentId}`, system: true });
  if (p.payer_user_id) {
    await notifyUsers(trx, tenantId, [p.payer_user_id], {
      kind: 'payment.refunding', title_ar: 'انتهت مهلة الحجز قبل اكتمال الدفع — سيتم استرداد المبلغ', title_en: 'Your hold expired before payment completed — a refund is being issued',
      target_path: `/account/bookings/${bookingId}`,
    });
  }
}

async function flagReconciliation(trx: Tx, tenantId: string, paymentId: string, note: string) {
  await trx.updateTable('payments').set({ needs_reconciliation: true, reconciliation_note: note }).where('id', '=', paymentId).execute();
  await notifyCapability(trx, tenantId, ['finance.view', 'refunds.approve'], { kind: 'payment.needs_reconciliation', title_ar: 'دفعة تحتاج مراجعة', title_en: 'A payment needs reconciliation', data: { payment_id: paymentId, note } });
}

// ── Webhooks ────────────────────────────────────────────────────────────────
/**
 * Provider webhook intake: verifies signature/timestamp, de-duplicates by event
 * id, matches amount/currency/account to the payment, and applies the event
 * exactly once. Duplicates and out-of-order events are no-ops.
 */
export async function handleWebhook(providerName: string, rawBody: string, headers: Headers) {
  const p = provider(providerName);
  if (!p) throw Errors.notFound();
  let ev: VerifiedEvent;
  try {
    ev = p.verifyWebhook(rawBody, headers);
  } catch (e) {
    if (e instanceof WebhookVerificationError) {
      await withSystem('record rejected webhook', (trx) => trx.insertInto('provider_events').values({
        provider: providerName, provider_event_id: `rejected:${Date.now()}:${Math.random().toString(36).slice(2)}`, event_type: 'rejected', signature_valid: false,
        payload: JSON.stringify({ reason: e.message, length: rawBody.length }), status: 'ignored', error: e.message,
      }).execute());
      throw new AppError(400, 'invalid_webhook', 'Webhook verification failed');
    }
    throw e;
  }
  const inserted = await withSystem('webhook intake', (trx) => trx.insertInto('provider_events').values({
    provider: providerName, provider_event_id: ev.eventId, event_type: ev.type, signature_valid: true, payload: JSON.stringify(ev.raw),
  }).onConflict((oc) => oc.columns(['provider', 'provider_event_id']).doNothing()).returning('id').executeTakeFirst());
  if (!inserted) return { status: 'duplicate' as const };
  try {
    const { result, tenantId } = await processEvent(providerName, ev);
    await withSystem('webhook processed', (trx) => trx.updateTable('provider_events').set({ status: result === 'needs_review' ? 'needs_review' : result === 'ignored' ? 'ignored' : 'processed', processed_at: new Date(), tenant_id: tenantId }).where('id', '=', inserted.id).execute());
    return { status: result };
  } catch (e) {
    await withSystem('webhook failed', (trx) => trx.updateTable('provider_events').set({ status: 'failed', error: (e as Error).message.slice(0, 500) }).where('id', '=', inserted.id).execute());
    throw e;
  }
}

type EventResult = 'processed' | 'ignored' | 'needs_review';

async function processEvent(providerName: string, ev: VerifiedEvent): Promise<{ result: EventResult; tenantId: string | null }> {
  if (ev.type.startsWith('refund.')) {
    const ref = (await sql<{ id: string; tenant_id: string }>`select * from app.refund_by_provider_ref(${ev.providerRefundId ?? ''})`.execute(db())).rows[0];
    if (!ref) return { result: 'needs_review', tenantId: null };
    const result = await withTenant(ref.tenant_id, async (trx): Promise<EventResult> => {
      const r = await trx.selectFrom('refunds').selectAll().where('id', '=', ref.id).forUpdate().executeTakeFirstOrThrow();
      if (r.amount_minor !== ev.amountMinor || r.currency !== ev.currency) return 'needs_review';
      if (r.status === 'succeeded' || r.status === 'failed') return 'ignored';
      if (ev.type === 'refund.failed') {
        await trx.updateTable('refunds').set({ status: 'failed' }).where('id', '=', r.id).execute();
        await refreshRefundStatus(trx, ref.tenant_id, r.payment_id);
        return 'processed';
      }
      await trx.updateTable('refunds').set({ status: 'succeeded', completed_at: new Date() }).where('id', '=', r.id).execute();
      await applyRefundSucceeded(trx, ref.tenant_id, r.id);
      return 'processed';
    });
    return { result, tenantId: ref.tenant_id };
  }
  const ref = (await sql<{ id: string; tenant_id: string }>`select * from app.payment_by_provider_ref(${providerName}, ${ev.providerPaymentId})`.execute(db())).rows[0];
  if (!ref) return { result: 'needs_review', tenantId: null };
  const result = await withTenant(ref.tenant_id, async (trx): Promise<EventResult> => {
    const pay = await trx.selectFrom('payments').selectAll().where('id', '=', ref.id).forUpdate().executeTakeFirstOrThrow();
    const acct = pay.payment_account_id ? await trx.selectFrom('payment_accounts').select(['merchant_ref', 'id']).where('id', '=', pay.payment_account_id).executeTakeFirst() : null;
    // Amount, currency and beneficiary account must all match what LUMA created.
    if (pay.amount_minor !== ev.amountMinor || pay.currency !== ev.currency || (acct && (acct.merchant_ref ?? acct.id) !== ev.accountRef)) {
      await flagReconciliation(trx, ref.tenant_id, pay.id, `webhook_mismatch:${ev.type}`);
      return 'needs_review';
    }
    if (ev.type === 'payment.captured') {
      if (pay.status === 'captured') return 'ignored';
      const wasFinal = ['failed', 'cancelled', 'expired'].includes(pay.status);
      await trx.updateTable('payments').set({ status: 'captured', captured_at: ev.createdAt, ...(wasFinal ? { needs_reconciliation: true, reconciliation_note: `captured_after_${pay.status}` } : {}) }).where('id', '=', pay.id).execute();
      await trx.updateTable('payment_attempts').set({ status: 'succeeded' }).where('payment_id', '=', pay.id).execute();
      await applyCaptured(trx, ref.tenant_id, pay.id, null);
      return 'processed';
    }
    // Failure/cancel after capture is out-of-order: never downgrade a captured payment.
    if (pay.status === 'captured') return 'ignored';
    const status = ev.type === 'payment.failed' ? 'failed' : 'cancelled';
    await trx.updateTable('payments').set({ status }).where('id', '=', pay.id).execute();
    await trx.updateTable('payment_attempts').set({ status: status === 'failed' ? 'failed' : 'cancelled' }).where('payment_id', '=', pay.id).execute();
    if (pay.booking_id) {
      // The customer may retry before the hold expires; a still-held booking returns to 'held'.
      await trx.updateTable('bookings').set({ status: 'held' }).where('id', '=', pay.booking_id).where('status', '=', 'pending_payment').execute();
    }
    if (pay.order_id) await paymentTargets.order.onFailed(trx, ref.tenant_id, pay.order_id, { paymentId: pay.id });
    return 'processed';
  });
  return { result, tenantId: ref.tenant_id };
}

// ── Refunds ─────────────────────────────────────────────────────────────────
type RefundRequest = { paymentId: string; amountMinor: number; reason: string; basis: Record<string, unknown>; idempotencyKey: string; system?: boolean; requestedBy?: string | null; approve?: boolean };

/**
 * Creates a refund within the refundable balance (captured − non-failed refunds),
 * locking the payment row so concurrent requests cannot exceed it. Approved
 * refunds are sent to the provider; cash refunds are recorded as paid out by staff.
 */
async function requestRefundInternal(trx: Tx, tenantId: string, r: RefundRequest) {
  const existing = await trx.selectFrom('refunds').select(['id', 'status']).where('idempotency_key', '=', r.idempotencyKey).executeTakeFirst();
  if (existing) return existing;
  const p = await trx.selectFrom('payments').selectAll().where('id', '=', r.paymentId).forUpdate().executeTakeFirst();
  if (!p) throw Errors.notFound('payment');
  if (p.status !== 'captured') throw Errors.conflict('payment_not_captured', 'Only captured payments can be refunded');
  const used = await trx.selectFrom('refunds').select(sql<number>`coalesce(sum(amount_minor), 0)::bigint`.as('n')).where('payment_id', '=', p.id).where('status', 'not in', ['failed', 'cancelled']).executeTakeFirstOrThrow();
  if (!(r.amountMinor > 0) || r.amountMinor + used.n > p.amount_minor) throw Errors.invalid('refund_exceeds_payment', 'Refund exceeds the refundable amount', { refundable_minor: p.amount_minor - used.n });
  const approved = r.system || r.approve;
  const row = await trx.insertInto('refunds').values({
    tenant_id: tenantId, payment_id: p.id, amount_minor: r.amountMinor, currency: p.currency, status: approved ? 'pending' : 'requested',
    reason: r.reason, basis: JSON.stringify(r.basis), idempotency_key: r.idempotencyKey, requested_by: r.requestedBy ?? null, requested_by_system: !!r.system,
  }).returning(['id', 'status']).executeTakeFirstOrThrow();
  await refreshRefundStatus(trx, tenantId, p.id);
  if (approved) await sendRefund(trx, tenantId, row.id);
  return row;
}

async function sendRefund(trx: Tx, tenantId: string, refundId: string) {
  const r = await trx.selectFrom('refunds').selectAll().where('id', '=', refundId).forUpdate().executeTakeFirstOrThrow();
  const p = await trx.selectFrom('payments').selectAll().where('id', '=', r.payment_id).executeTakeFirstOrThrow();
  if (p.method === 'cash' || p.method === 'pos_terminal' || p.method === 'gift_card') {
    // Cash refunds are handed back at the counter (staff recorded in audit); gift-card payments return to the card.
    await trx.updateTable('refunds').set({ status: 'succeeded', completed_at: new Date() }).where('id', '=', r.id).execute();
    await applyRefundSucceeded(trx, tenantId, r.id);
    return;
  }
  const prov = provider(p.provider);
  if (!prov || !p.provider_payment_id) throw Errors.unavailable('payments_unavailable');
  const res = await prov.refund({ providerPaymentId: p.provider_payment_id, amountMinor: r.amount_minor, currency: r.currency, idempotencyKey: r.idempotency_key });
  await trx.updateTable('refunds').set({ provider_refund_id: res.providerRefundId, status: res.status === 'failed' ? 'failed' : 'pending' }).where('id', '=', r.id).execute();
  await refreshRefundStatus(trx, tenantId, p.id);
}

/** Money moves back only on provider confirmation; journal + target balances update exactly once. */
async function applyRefundSucceeded(trx: Tx, tenantId: string, refundId: string) {
  const r = await trx.selectFrom('refunds').selectAll().where('id', '=', refundId).executeTakeFirstOrThrow();
  const p = await trx.selectFrom('payments').selectAll().where('id', '=', r.payment_id).executeTakeFirstOrThrow();
  const cashAccount = ledgerAccount(p.method);
  for (const h of refundHooks) await h(trx, tenantId, r.id);
  if (p.booking_id) {
    const b = await trx.selectFrom('bookings').selectAll().where('id', '=', p.booking_id).forUpdate().executeTakeFirstOrThrow();
    await trx.updateTable('bookings').set({ refunded_minor: b.refunded_minor + r.amount_minor }).where('id', '=', b.id).execute();
    await post(trx, tenantId, { type: 'refund', id: r.id }, [
      { account: b.status === 'completed' ? 'refunds' : 'customer_deposits', debit: r.amount_minor }, { account: cashAccount, credit: r.amount_minor },
    ], { memo: `refund ${b.number}` });
  } else if (p.order_id) {
    const o = await trx.selectFrom('orders').selectAll().where('id', '=', p.order_id).forUpdate().executeTakeFirstOrThrow();
    await trx.updateTable('orders').set({ refunded_minor: o.refunded_minor + r.amount_minor }).where('id', '=', o.id).execute();
    await post(trx, tenantId, { type: 'refund', id: r.id }, [{ account: 'refunds', debit: r.amount_minor }, { account: cashAccount, credit: r.amount_minor }], { memo: `refund ${o.number}` });
  } else {
    await post(trx, tenantId, { type: 'refund', id: r.id }, [{ account: p.gift_card_id ? 'gift_card_liability' : 'membership_liability', debit: r.amount_minor }, { account: cashAccount, credit: r.amount_minor }]);
  }
  await refreshRefundStatus(trx, tenantId, p.id);
}

type RefundHook = (trx: Tx, tenantId: string, refundId: string) => Promise<void>;
const refundHooks: RefundHook[] = [];
/** Side effects when money actually moves back (loyalty reversal, gift card restore). */
export function onRefundSucceeded(h: RefundHook) {
  refundHooks.push(h);
}

/** Recomputes the target's refund status: refund_pending is not refunded; only succeeded refunds count. */
async function refreshRefundStatus(trx: Tx, tenantId: string, paymentId: string) {
  const p = await trx.selectFrom('payments').select(['booking_id', 'order_id']).where('id', '=', paymentId).executeTakeFirstOrThrow();
  if (p.booking_id) {
    const b = await trx.selectFrom('bookings').select(['id', 'paid_minor', 'refunded_minor', 'total_minor', 'payment_status']).where('id', '=', p.booking_id).executeTakeFirstOrThrow();
    const pending = await trx.selectFrom('refunds as r').innerJoin('payments as p', 'p.id', 'r.payment_id').select('r.id').where('p.booking_id', '=', b.id).where('r.status', 'in', ['requested', 'pending']).execute();
    let status = b.payment_status;
    if (pending.length) status = 'refund_pending';
    else if (b.refunded_minor > 0 && b.refunded_minor >= b.paid_minor) status = 'refunded';
    else if (b.refunded_minor > 0) status = 'partially_refunded';
    else status = b.paid_minor <= 0 ? 'unpaid' : b.paid_minor >= b.total_minor ? 'paid' : 'partially_paid';
    await trx.updateTable('bookings').set({ payment_status: status }).where('id', '=', b.id).execute();
  }
  if (p.order_id) {
    const o = await trx.selectFrom('orders').select(['id', 'paid_minor', 'refunded_minor']).where('id', '=', p.order_id).executeTakeFirstOrThrow();
    const pending = await trx.selectFrom('refunds as r').innerJoin('payments as p', 'p.id', 'r.payment_id').select('r.id').where('p.order_id', '=', o.id).where('r.status', 'in', ['requested', 'pending']).execute();
    const status = pending.length ? 'pending' : o.refunded_minor <= 0 ? 'none' : o.refunded_minor >= o.paid_minor ? 'full' : 'partial';
    await trx.updateTable('orders').set({ refund_status: status }).where('id', '=', o.id).execute();
  }
}

/** Staff refund request (refunds.request). Approval needs refunds.approve (may be the same person if she holds both). */
export async function requestRefund(access: TenantAccess, actor: AuditActor, input: { paymentId: string; amountMinor: number; reason: string; idempotencyKey: string }) {
  return withTenant(access.tenantId, async (trx) => {
    const r = await requestRefundInternal(trx, access.tenantId, {
      paymentId: input.paymentId, amountMinor: input.amountMinor, reason: input.reason, basis: { manual: true }, idempotencyKey: `manual:${input.idempotencyKey}`,
      requestedBy: actor.userId, approve: hasCapability(access, 'refunds.approve'),
    });
    await audit(trx, actor, 'refund.requested', { tenantId: access.tenantId, targetType: 'refund', targetId: r.id, data: { amount_minor: input.amountMinor, reason: input.reason } });
    return r;
  });
}

export async function approveRefund(access: TenantAccess, actor: AuditActor, refundId: string) {
  return withTenant(access.tenantId, async (trx) => {
    const r = await trx.selectFrom('refunds').selectAll().where('id', '=', refundId).forUpdate().executeTakeFirst();
    if (!r) throw Errors.notFound('refund');
    if (r.status !== 'requested') throw Errors.conflict('already_decided');
    await trx.updateTable('refunds').set({ status: 'pending' }).where('id', '=', refundId).execute();
    await sendRefund(trx, access.tenantId, refundId);
    await audit(trx, actor, 'refund.approved', { tenantId: access.tenantId, targetType: 'refund', targetId: refundId, data: { amount_minor: r.amount_minor } });
    return { id: refundId, status: 'pending' };
  });
}

/** Booking hook: refund due on cancellation per the snapshot terms (system-approved). */
export async function refundBookingDue(trx: Tx, tenantId: string, bookingId: string, amountMinor: number, basis: string) {
  const pays = await trx.selectFrom('payments').selectAll().where('booking_id', '=', bookingId).where('status', '=', 'captured').orderBy('captured_at', 'desc').execute();
  let remaining = amountMinor;
  for (const p of pays) {
    if (remaining <= 0) break;
    const used = await trx.selectFrom('refunds').select(sql<number>`coalesce(sum(amount_minor), 0)::bigint`.as('n')).where('payment_id', '=', p.id).where('status', 'not in', ['failed', 'cancelled']).executeTakeFirstOrThrow();
    const room = p.amount_minor - used.n;
    if (room <= 0) continue;
    const amt = Math.min(room, remaining);
    await requestRefundInternal(trx, tenantId, { paymentId: p.id, amountMinor: amt, reason: basis, basis: { policy: basis }, idempotencyKey: `policy:${bookingId}:${p.id}:${basis}`, system: true });
    remaining -= amt;
  }
  return amountMinor - remaining;
}

// ── Reconciliation ──────────────────────────────────────────────────────────
/**
 * Compares provider records with LUMA's payments for a tenant and repairs safe
 * cases: provider says captured but LUMA didn't apply (lost webhook) → apply;
 * pending payments past expiry with no capture → expire. Everything else is
 * reported as a discrepancy for a human.
 */
export async function reconcileTenant(tenantId: string, actorUserId: string | null = null) {
  const pays = await withTenant(tenantId, (trx) => trx.selectFrom('payments').selectAll().where('provider', '<>', 'on_site').where('created_at', '>', new Date(Date.now() - 30 * 86_400_000)).execute());
  const discrepancies: Array<Record<string, unknown>> = [];
  let repaired = 0;
  for (const p of pays) {
    const prov = provider(p.provider);
    if (!prov || !p.provider_payment_id) continue;
    const remote = await prov.fetchPayment(p.provider_payment_id);
    if (!remote) { discrepancies.push({ payment_id: p.id, issue: 'missing_at_provider' }); continue; }
    if (remote.amountMinor !== p.amount_minor || remote.currency !== p.currency) discrepancies.push({ payment_id: p.id, issue: 'amount_mismatch' });
    if (remote.status === 'captured' && p.status !== 'captured') {
      await withTenant(tenantId, async (trx) => {
        const locked = await trx.selectFrom('payments').select('status').where('id', '=', p.id).forUpdate().executeTakeFirstOrThrow();
        if (locked.status === 'captured') return;
        await trx.updateTable('payments').set({ status: 'captured', captured_at: new Date() }).where('id', '=', p.id).execute();
        await applyCaptured(trx, tenantId, p.id, actorUserId);
      });
      repaired++;
    } else if (['pending', 'requires_action'].includes(p.status) && p.expires_at && p.expires_at < new Date() && remote.status !== 'captured') {
      await withTenant(tenantId, (trx) => trx.updateTable('payments').set({ status: 'expired' }).where('id', '=', p.id).where('status', 'in', ['pending', 'requires_action']).execute());
    }
    if (p.needs_reconciliation) discrepancies.push({ payment_id: p.id, issue: p.reconciliation_note ?? 'flagged' });
  }
  await withTenant(tenantId, (trx) => trx.insertInto('reconciliation_runs').values({
    tenant_id: tenantId, provider: 'all', period_start: new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10), period_end: new Date().toISOString().slice(0, 10),
    status: discrepancies.length ? 'discrepancies' : 'balanced', summary: JSON.stringify({ checked: pays.length, repaired }), discrepancies: JSON.stringify(discrepancies), created_by: actorUserId, finished_at: new Date(),
  }).execute());
  return { checked: pays.length, repaired, discrepancies };
}

export function sandboxEnabled() {
  return !!env().PAYMENT_SANDBOX_WEBHOOK_SECRET;
}
