import { describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { NextRequest } from 'next/server';
import { at, customer, futureDate, makeSalon, type Salon } from '../helpers/salon';
import { withSystem, withTenant } from '@/server/db/client';
import * as hold from '@/app/api/v1/s/[slug]/bookings/route';
import * as checkout from '@/app/api/v1/s/[slug]/bookings/[id]/checkout/route';
import * as sandboxPay from '@/app/api/v1/sandbox/checkout/[providerPaymentId]/route';
import * as sandboxRefund from '@/app/api/v1/sandbox/refunds/[providerRefundId]/route';
import * as webhook from '@/app/api/v1/payments/webhooks/[provider]/route';
import * as onSite from '@/app/api/v1/t/[tenantSlug]/payments/on-site/route';
import * as refunds from '@/app/api/v1/t/[tenantSlug]/refunds/route';
import * as accountCancel from '@/app/api/v1/account/bookings/[id]/cancel/route';
import { buildSandboxEvent } from '@/server/domains/payments/providers/sandbox';
import { expireStaleHolds } from '@/server/domains/booking/service';
import { reconcileTenant } from '@/server/domains/payments/service';

const item = (service_id: string, staff_id: string, start: string) => ({ key: 'a', service_id, staff_id, start });

async function postWebhook(body: string, headers: Record<string, string>) {
  const req = new NextRequest('http://localhost:3000/api/v1/payments/webhooks/sandbox', { method: 'POST', body, headers });
  const res = await webhook.POST(req, { params: Promise.resolve({ provider: 'sandbox' }) });
  return { status: res.status, body: await res.json() };
}

async function heldBooking(s: Salon, start: string, service = s.services.color) {
  const c = await customer();
  const h = await c.call(hold.POST, { params: { slug: s.slug }, body: { items: [item(service, s.staff.sara, start)] }, idempotencyKey: true });
  expect(h.status).toBe(201);
  return { c, id: h.body.data.booking_id as string, terms: h.body.data.payment_terms };
}

const booking = (s: Salon, id: string) => withTenant(s.tenantId, (trx) => trx.selectFrom('bookings').selectAll().where('id', '=', id).executeTakeFirstOrThrow());
const providerId = (s: Salon, paymentId: string) => withTenant(s.tenantId, (trx) => trx.selectFrom('payments').select(['provider_payment_id', 'amount_minor', 'currency']).where('id', '=', paymentId).executeTakeFirstOrThrow());

describe('booking checkout & sandbox payments', () => {
  it('deposit: server computes the amount; success confirms via webhook; the redirect alone proves nothing', async () => {
    const s = await makeSalon({ settings: { deposit_mode: 'percent', deposit_percent_bp: 2500, allow_pay_on_site: false } });
    const { c, id, terms } = await heldBooking(s, at(futureDate(4), '11:00'));
    expect(terms.allowed.sort()).toEqual(['deposit', 'full']);
    expect(terms.depositMinor).toBe(7500);
    // Manipulated option the policy does not allow.
    const bad = await c.call(checkout.POST, { params: { slug: s.slug, id }, body: { option: 'on_site' }, idempotencyKey: true });
    expect(bad.status).toBe(422);
    const co = await c.call(checkout.POST, { params: { slug: s.slug, id }, body: { option: 'deposit' }, idempotencyKey: true });
    expect(co.status).toBe(201);
    expect(co.body.data.payment.amount_minor).toBe(7500);
    expect(co.body.data.payment.simulation).toBe(true);
    expect((await booking(s, id)).status).toBe('pending_payment');
    const pp = await providerId(s, co.body.data.payment.id);
    const done = await c.call(sandboxPay.POST, { params: { providerPaymentId: pp.provider_payment_id! }, body: { outcome: 'captured' } });
    expect(done.body.data.webhook).toBe('processed');
    const b = await booking(s, id);
    expect(b.status).toBe('confirmed');
    expect(b.payment_status).toBe('deposit_paid');
    expect(b.paid_minor).toBe(7500);
    const dep = await withTenant(s.tenantId, (trx) => trx.selectFrom('financial_entries').select(['account', 'credit_minor']).where('account', '=', 'customer_deposits').where('credit_minor', '>', 0).execute());
    expect(dep.reduce((a, e) => a + e.credit_minor, 0)).toBe(7500); // a deposit is not revenue
  });

  it('rejects forged, stale-timestamp and malformed webhooks; duplicates are no-ops', async () => {
    const s = await makeSalon({ settings: { allow_pay_on_site: false } });
    const { c, id } = await heldBooking(s, at(futureDate(5), '11:00'));
    const co = await c.call(checkout.POST, { params: { slug: s.slug, id }, body: { option: 'full' }, idempotencyKey: true });
    const pp = await providerId(s, co.body.data.payment.id);
    const data = { payment_id: pp.provider_payment_id, amount: pp.amount_minor, currency: 'SAR', account: `sbx_acct_${s.tenantId.slice(0, 8)}` };
    const ev = buildSandboxEvent('payment.captured', data);
    const sig = ev.headers['x-sandbox-signature'];
    const forged = sig.slice(0, -1) + (sig.endsWith('0') ? '1' : '0'); // always differs from the real signature
    expect((await postWebhook(ev.body, { 'x-sandbox-signature': forged })).status).toBe(400);
    const stale = buildSandboxEvent('payment.captured', data, { ts: Math.floor(Date.now() / 1000) - 3600 });
    expect((await postWebhook(stale.body, stale.headers)).status).toBe(400);
    expect((await postWebhook('{"nope":1}', { 'x-sandbox-signature': 't=1,v1=00' })).status).toBe(400);
    expect((await booking(s, id)).status).toBe('pending_payment');
    const ok = await postWebhook(ev.body, ev.headers);
    expect(ok.body.data.status).toBe('processed');
    const dup = await postWebhook(ev.body, ev.headers);
    expect(dup.body.data.status).toBe('duplicate');
    // A second, distinct capture event for the same payment is ignored (no double credit).
    const again = buildSandboxEvent('payment.captured', data);
    expect((await postWebhook(again.body, again.headers)).body.data.status).toBe('ignored');
    // Out-of-order failure after capture never downgrades it.
    const late = buildSandboxEvent('payment.failed', data);
    expect((await postWebhook(late.body, late.headers)).body.data.status).toBe('ignored');
    const b = await booking(s, id);
    expect(b.paid_minor).toBe(pp.amount_minor);
    expect(b.status).toBe('confirmed');
  });

  it('amount, currency or account mismatch is flagged for review and does not confirm', async () => {
    const s = await makeSalon({ settings: { allow_pay_on_site: false } });
    const { c, id } = await heldBooking(s, at(futureDate(5), '13:00'));
    const co = await c.call(checkout.POST, { params: { slug: s.slug, id }, body: { option: 'full' }, idempotencyKey: true });
    const pp = await providerId(s, co.body.data.payment.id);
    for (const data of [
      { payment_id: pp.provider_payment_id, amount: 1, currency: 'SAR', account: `sbx_acct_${s.tenantId.slice(0, 8)}` },
      { payment_id: pp.provider_payment_id, amount: pp.amount_minor, currency: 'USD', account: `sbx_acct_${s.tenantId.slice(0, 8)}` },
      { payment_id: pp.provider_payment_id, amount: pp.amount_minor, currency: 'SAR', account: 'someone-else' },
    ]) {
      const ev = buildSandboxEvent('payment.captured', data);
      expect((await postWebhook(ev.body, ev.headers)).body.data.status).toBe('needs_review');
    }
    const b = await booking(s, id);
    expect(b.status).toBe('pending_payment');
    expect(b.paid_minor).toBe(0);
  });

  it('late success after hold expiry: confirms if the slot is still free, refunds if it was taken', async () => {
    const s = await makeSalon({ settings: { allow_pay_on_site: false } });
    const d = futureDate(6);
    const expire = async (id: string) => {
      await withSystem('test', (trx) => sql`update bookings set hold_expires_at = now() - interval '1 minute' where id = ${id}`.execute(trx));
      await withSystem('test', (trx) => sql`update booking_allocations set expires_at = now() - interval '1 minute' where booking_id = ${id}`.execute(trx));
      await expireStaleHolds();
    };
    // Case 1: slot still free.
    const a = await heldBooking(s, at(d, '10:00'));
    const coA = await a.c.call(checkout.POST, { params: { slug: s.slug, id: a.id }, body: { option: 'full' }, idempotencyKey: true });
    await expire(a.id);
    expect((await booking(s, a.id)).status).toBe('expired');
    const ppA = await providerId(s, coA.body.data.payment.id);
    await a.c.call(sandboxPay.POST, { params: { providerPaymentId: ppA.provider_payment_id! }, body: { outcome: 'captured' } });
    expect((await booking(s, a.id)).status).toBe('confirmed');

    // Case 2: slot taken by someone else meanwhile.
    const b = await heldBooking(s, at(d, '14:00'));
    const coB = await b.c.call(checkout.POST, { params: { slug: s.slug, id: b.id }, body: { option: 'full' }, idempotencyKey: true });
    await expire(b.id);
    const thief = await heldBooking(s, at(d, '14:00'));
    expect(thief.id).toBeTruthy();
    const ppB = await providerId(s, coB.body.data.payment.id);
    await b.c.call(sandboxPay.POST, { params: { providerPaymentId: ppB.provider_payment_id! }, body: { outcome: 'captured' } });
    const bb = await booking(s, b.id);
    expect(bb.status).toBe('cancelled');
    expect(bb.payment_status).toBe('refund_pending'); // pending is NOT refunded
    const pay = await withTenant(s.tenantId, (trx) => trx.selectFrom('payments').select(['needs_reconciliation', 'reconciliation_note']).where('id', '=', coB.body.data.payment.id).executeTakeFirstOrThrow());
    expect(pay.needs_reconciliation).toBe(true);
    const rf = await withTenant(s.tenantId, (trx) => trx.selectFrom('refunds').select(['provider_refund_id', 'status']).where('payment_id', '=', coB.body.data.payment.id).executeTakeFirstOrThrow());
    expect(rf.status).toBe('pending');
    await b.c.call(sandboxRefund.POST, { params: { providerRefundId: rf.provider_refund_id! }, body: { outcome: 'succeeded' } });
    const final = await booking(s, b.id);
    expect(final.payment_status).toBe('refunded');
    expect(final.refunded_minor).toBe(final.paid_minor);
  });

  it('on-site collection needs a reference and cannot exceed the balance', async () => {
    const s = await makeSalon();
    const { c, id } = await heldBooking(s, at(futureDate(7), '11:00'), s.services.haircut);
    await c.call(checkout.POST, { params: { slug: s.slug, id }, body: { option: 'on_site' }, idempotencyKey: true });
    const p = { tenantSlug: s.slug };
    expect((await s.owner.call(onSite.POST, { params: p, body: { booking_id: id, amount_minor: 10000, method: 'cash' }, idempotencyKey: true })).status).toBe(422);
    expect((await s.owner.call(onSite.POST, { params: p, body: { booking_id: id, amount_minor: -5, method: 'cash', reference: 'R1' }, idempotencyKey: true })).status).toBe(422);
    expect((await s.owner.call(onSite.POST, { params: p, body: { booking_id: id, amount_minor: 999999, method: 'cash', reference: 'R1' }, idempotencyKey: true })).body.error.code).toBe('amount_exceeds_due');
    const ok = await s.owner.call(onSite.POST, { params: p, body: { booking_id: id, amount_minor: 10000, method: 'cash', reference: 'RCPT-1' }, idempotencyKey: true });
    expect(ok.status).toBe(201);
    expect((await booking(s, id)).payment_status).toBe('paid');
  });

  it('refunds are capped and deduplicated even when requested concurrently', async () => {
    const s = await makeSalon();
    const { c, id } = await heldBooking(s, at(futureDate(8), '11:00'), s.services.haircut);
    await c.call(checkout.POST, { params: { slug: s.slug, id }, body: { option: 'on_site' }, idempotencyKey: true });
    const pay = await s.owner.call(onSite.POST, { params: { tenantSlug: s.slug }, body: { booking_id: id, amount_minor: 10000, method: 'cash', reference: 'RCPT-2' }, idempotencyKey: true });
    const body = { payment_id: pay.body.data.payment_id, amount_minor: 7000, reason: 'service issue' };
    const [r1, r2] = await Promise.all([
      s.owner.call(refunds.POST, { params: { tenantSlug: s.slug }, body, idempotencyKey: true }),
      s.owner.call(refunds.POST, { params: { tenantSlug: s.slug }, body, idempotencyKey: true }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([201, 422]);
    const same = await s.owner.call(refunds.POST, { params: { tenantSlug: s.slug }, body: { ...body, amount_minor: 3000 }, idempotencyKey: 'refund-key-abcdef' });
    const replay = await s.owner.call(refunds.POST, { params: { tenantSlug: s.slug }, body: { ...body, amount_minor: 3000 }, idempotencyKey: 'refund-key-abcdef' });
    expect(same.body.data.id).toBe(replay.body.data.id);
    const b = await booking(s, id);
    expect(b.refunded_minor).toBe(10000);
    expect(b.payment_status).toBe('refunded');
  });

  it('customer cancellation uses the terms captured at booking time', async () => {
    // Free cancellation up to 96h before; an appointment ~2 days away is therefore "late".
    const s = await makeSalon({ settings: { allow_pay_on_site: false, free_cancellation_hours: 96, late_cancellation_fee_bp: 5000 } });
    const { c, id } = await heldBooking(s, at(futureDate(2), '11:00'), s.services.haircut);
    const co = await c.call(checkout.POST, { params: { slug: s.slug, id }, body: { option: 'full' }, idempotencyKey: true });
    const pp = await providerId(s, co.body.data.payment.id);
    await c.call(sandboxPay.POST, { params: { providerPaymentId: pp.provider_payment_id! }, body: { outcome: 'captured' } });
    // The business later makes its policy stricter; the booking keeps its snapshot.
    await withSystem('test', (trx) => trx.updateTable('tenant_settings').set({ late_cancellation_fee_bp: 10000 }).where('tenant_id', '=', s.tenantId).execute());
    const r = await c.call(accountCancel.POST, { params: { id }, body: { reason: 'cannot come' } });
    expect(r.body.data.refund_due_minor).toBe(5000);
    expect(r.body.data.refund_basis).toBe('late_cancellation');
    const retained = await withTenant(s.tenantId, (trx) => trx.selectFrom('financial_entries').select(['account', 'credit_minor']).where('ref_type', '=', 'booking_retained').where('ref_id', '=', id).execute());
    expect(retained.find((e) => e.account === 'service_revenue')?.credit_minor).toBe(5000);
  });

  it('reconciliation applies a capture whose webhook was lost', async () => {
    const s = await makeSalon({ settings: { allow_pay_on_site: false } });
    const { c, id } = await heldBooking(s, at(futureDate(9), '11:00'));
    const co = await c.call(checkout.POST, { params: { slug: s.slug, id }, body: { option: 'full' }, idempotencyKey: true });
    const pp = await providerId(s, co.body.data.payment.id);
    // Provider captured, webhook never arrived.
    await withSystem('test', (trx) => sql`update sandbox_provider_payments set status = 'captured' where id = ${pp.provider_payment_id}`.execute(trx));
    const r = await reconcileTenant(s.tenantId);
    expect(r.repaired).toBe(1);
    expect((await booking(s, id)).status).toBe('confirmed');
    expect((await reconcileTenant(s.tenantId)).repaired).toBe(0);
  });
});
