import { describe, expect, it } from 'vitest';
import { customer, makeSalon } from '../helpers/salon';
import { withSystem, withTenant } from '@/server/db/client';
import { db } from '@/server/db/client';
import { deliverDueGiftCards, giftByToken } from '@/server/domains/giftcards/online';
import * as purchase from '@/app/api/v1/s/[slug]/gift-cards/purchase/route';
import * as purchaseStatus from '@/app/api/v1/s/[slug]/gift-cards/purchases/[id]/route';
import * as giftBalance from '@/app/api/v1/s/[slug]/gift-cards/balance/route';
import * as plans from '@/app/api/v1/t/[tenantSlug]/membership-plans/route';
import * as buyMembership from '@/app/api/v1/s/[slug]/memberships/purchase/route';
import * as membershipStatus from '@/app/api/v1/s/[slug]/memberships/purchases/[id]/route';
import * as sandboxPay from '@/app/api/v1/sandbox/checkout/[providerPaymentId]/route';

async function providerRef(tenantId: string, paymentId: string) {
  return withTenant(tenantId, (trx) => trx.selectFrom('payments').select(['provider_payment_id', 'purpose', 'amount_minor', 'status']).where('id', '=', paymentId).executeTakeFirstOrThrow());
}

describe('online gift card purchase with scheduled direct send', () => {
  it('pays through the sandbox provider, activates once, and sends the code to the recipient at the chosen time', async () => {
    const s = await makeSalon();
    const c = await customer('Gift buyer');
    const sendAt = new Date(Date.now() + 2 * 3_600_000);
    const phone = `+9665${Math.floor(10000000 + Math.random() * 89999999)}`;
    const body = { amount_minor: 25000, template_key: 'floral', recipient_name: 'نورة', recipient_phone: phone, message: 'كل عام وأنتِ بخير', send_at: sendAt.toISOString() };
    const key = `gift-${Date.now()}`;
    const r = await c.call(purchase.POST, { params: { slug: s.slug }, body, idempotencyKey: key });
    expect(r.status).toBe(201);
    expect(r.body.data.payment).toMatchObject({ amount_minor: 25000, simulation: true });
    const cardId = r.body.data.gift_card_id as string;
    // Retrying with the same key replays the same purchase (no second card or payment).
    const replay = await c.call(purchase.POST, { params: { slug: s.slug }, body, idempotencyKey: key });
    expect(replay.body.data.gift_card_id).toBe(cardId);
    expect((await withTenant(s.tenantId, (trx) => trx.selectFrom('gift_cards').select('id').execute())).length).toBe(1);

    // Before payment: pending card, nothing scheduled, nothing redeemable.
    let st = await c.call(purchaseStatus.GET, { params: { slug: s.slug, id: cardId } });
    expect(st.body.data).toMatchObject({ card_status: 'pending', delivery_status: 'awaiting_payment' });
    expect(JSON.stringify(st.body.data)).not.toMatch(/code_ciphertext/);
    await deliverDueGiftCards(new Date(sendAt.getTime() + 60_000));
    expect((await withTenant(s.tenantId, (trx) => trx.selectFrom('gift_card_deliveries').select('status').executeTakeFirstOrThrow())).status).toBe('awaiting_payment');

    // Verified capture (signed webhook through the sandbox provider) activates the card and schedules delivery.
    const pay = await providerRef(s.tenantId, r.body.data.payment.id);
    expect(pay).toMatchObject({ purpose: 'gift_card', amount_minor: 25000 });
    const done = await c.call(sandboxPay.POST, { params: { providerPaymentId: pay.provider_payment_id! }, body: { outcome: 'captured' } });
    expect(done.body.data.webhook).toBe('processed');
    st = await c.call(purchaseStatus.GET, { params: { slug: s.slug, id: cardId } });
    expect(st.body.data).toMatchObject({ card_status: 'active', delivery_status: 'scheduled', initial_minor: 25000 });
    const card = await withTenant(s.tenantId, (trx) => trx.selectFrom('gift_cards').select(['balance_minor', 'status', 'expires_at']).where('id', '=', cardId).executeTakeFirstOrThrow());
    expect(card).toMatchObject({ balance_minor: 25000, status: 'active' });
    const journal = await withTenant(s.tenantId, (trx) => trx.selectFrom('financial_entries').select(['account', 'debit_minor', 'credit_minor']).where('ref_type', '=', 'payment').where('ref_id', '=', r.body.data.payment.id).orderBy('account').execute());
    expect(journal).toEqual([
      { account: 'gift_card_liability', debit_minor: 0, credit_minor: 25000 },
      { account: 'provider_clearing', debit_minor: 25000, credit_minor: 0 },
    ]);

    // Not yet time: nothing is sent.
    await deliverDueGiftCards(new Date(sendAt.getTime() - 60_000));
    expect((await withTenant(s.tenantId, (trx) => trx.selectFrom('gift_card_deliveries').select('status').executeTakeFirstOrThrow())).status).toBe('scheduled');
    // At the chosen time: delivered through the messaging abstraction (dev outbox = simulated, recorded honestly).
    const out = await deliverDueGiftCards(new Date(sendAt.getTime() + 60_000));
    expect(out.find((x) => x.status)?.status).toBe('simulated');
    const d = await withTenant(s.tenantId, (trx) => trx.selectFrom('gift_card_deliveries').select(['status', 'channels', 'sent_at', 'attempts']).executeTakeFirstOrThrow());
    expect(d).toMatchObject({ status: 'simulated', attempts: 1 });
    expect(d.channels).toHaveLength(1);
    const msg = await db().selectFrom('dev_message_outbox').select(['body', 'channel']).where('destination', '=', phone).executeTakeFirstOrThrow();
    const code = /([A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4})/.exec(msg.body)![1]!;
    const token = /\/gift\/([A-Za-z0-9_-]+)/.exec(msg.body)![1]!;
    expect(msg.body).toContain('نورة');
    expect(msg.body).toContain(`/s/${s.slug}/gift/`);
    // A second run never re-sends.
    await deliverDueGiftCards(new Date(sendAt.getTime() + 3_600_000));
    expect((await db().selectFrom('dev_message_outbox').select('id').where('destination', '=', phone).execute()).length).toBe(1);

    // The recipient's page and the code work; the card still stores only a hash.
    const view = await giftByToken(s.tenantId, token);
    expect(view).toMatchObject({ code, recipient_name: 'نورة', initial_minor: 25000, balance_minor: 25000, message: 'كل عام وأنتِ بخير' });
    await expect(giftByToken(s.tenantId, 'x'.repeat(32))).rejects.toThrow();
    const recipient = await customer('Recipient');
    expect((await recipient.call(giftBalance.POST, { params: { slug: s.slug }, body: { code } })).body.data.balance_minor).toBe(25000);
    const stored = await withSystem('test', (trx) => trx.selectFrom('gift_cards').selectAll().where('id', '=', cardId).executeTakeFirstOrThrow());
    expect(JSON.stringify(stored)).not.toContain(code.replace(/-/g, ''));

    // Only the buyer sees her purchase.
    expect((await recipient.call(purchaseStatus.GET, { params: { slug: s.slug, id: cardId } })).status).toBe(404);
  });

  it('requires a recipient contact and a future send time', async () => {
    const s = await makeSalon();
    const c = await customer('Careless buyer');
    const noContact = await c.call(purchase.POST, { params: { slug: s.slug }, body: { amount_minor: 10000, recipient_name: 'سارة' }, idempotencyKey: true });
    expect(noContact.status).toBe(422);
    const past = await c.call(purchase.POST, { params: { slug: s.slug }, body: { amount_minor: 10000, recipient_name: 'سارة', recipient_email: 'sara@example.test', send_at: new Date(Date.now() - 3_600_000).toISOString() }, idempotencyKey: true });
    expect(past.body.error.code).toBe('send_at_in_past');
    // Sent immediately when no time is chosen (email channel).
    const now = await c.call(purchase.POST, { params: { slug: s.slug }, body: { amount_minor: 10000, recipient_name: 'سارة', recipient_email: 'sara-gift@example.test' }, idempotencyKey: true });
    const pay = await providerRef(s.tenantId, now.body.data.payment.id);
    await c.call(sandboxPay.POST, { params: { providerPaymentId: pay.provider_payment_id! }, body: { outcome: 'captured' } });
    await deliverDueGiftCards(new Date(Date.now() + 1000));
    const d = await withTenant(s.tenantId, (trx) => trx.selectFrom('gift_card_deliveries').select(['status', 'channels']).where('gift_card_id', '=', now.body.data.gift_card_id).executeTakeFirstOrThrow());
    expect(d).toEqual({ status: 'simulated', channels: ['email'] });
  });
});

describe('online membership purchase', () => {
  it('creates a pending membership, activates it on the verified capture and books the liability', async () => {
    const s = await makeSalon();
    const plan = await s.owner.call(plans.POST, { params: { tenantSlug: s.slug }, body: { name_ar: 'باقة قص', price_minor: 30000, validity_days: 90, items: [{ service_id: s.services.haircut, sessions: 3 }] } });
    const c = await customer('Member online');
    const r = await c.call(buyMembership.POST, { params: { slug: s.slug }, body: { plan_id: plan.body.data.id }, idempotencyKey: true });
    expect(r.status).toBe(201);
    expect(r.body.data.status).toBe('pending_payment');
    const id = r.body.data.membership_id as string;
    let st = await c.call(membershipStatus.GET, { params: { slug: s.slug, id } });
    expect(st.body.data).toMatchObject({ status: 'pending_payment', entitlements: [] });

    const pay = await providerRef(s.tenantId, r.body.data.payment.id);
    expect(pay).toMatchObject({ purpose: 'membership', amount_minor: 30000 });
    // A failed attempt does not activate anything.
    await c.call(sandboxPay.POST, { params: { providerPaymentId: pay.provider_payment_id! }, body: { outcome: 'failed' } });
    st = await c.call(membershipStatus.GET, { params: { slug: s.slug, id } });
    expect(st.body.data.status).toBe('pending_payment');

    const r2 = await c.call(buyMembership.POST, { params: { slug: s.slug }, body: { plan_id: plan.body.data.id }, idempotencyKey: true });
    const pay2 = await providerRef(s.tenantId, r2.body.data.payment.id);
    await c.call(sandboxPay.POST, { params: { providerPaymentId: pay2.provider_payment_id! }, body: { outcome: 'captured' } });
    st = await c.call(membershipStatus.GET, { params: { slug: s.slug, id: r2.body.data.membership_id } });
    expect(st.body.data.status).toBe('active');
    expect(st.body.data.entitlements).toEqual([{ service_id: s.services.haircut, total: 3, used: 0, reserved: 0 }]);
    const liab = await withTenant(s.tenantId, (trx) => trx.selectFrom('financial_entries').select('credit_minor').where('account', '=', 'membership_liability').where('ref_id', '=', r2.body.data.payment.id).execute());
    expect(liab).toEqual([{ credit_minor: 30000 }]);
    const n = await withTenant(s.tenantId, (trx) => trx.selectFrom('notifications').select('kind').where('kind', '=', 'membership.activated').execute());
    expect(n).toHaveLength(1);
    // Hidden/inactive plans cannot be bought.
    await withTenant(s.tenantId, (trx) => trx.updateTable('membership_plans').set({ is_visible: false }).where('id', '=', plan.body.data.id).execute());
    expect((await c.call(buyMembership.POST, { params: { slug: s.slug }, body: { plan_id: plan.body.data.id }, idempotencyKey: true })).status).toBe(404);
  });
});
