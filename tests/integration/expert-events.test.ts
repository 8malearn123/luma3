import { describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { at, customer, futureDate } from '../helpers/salon';
import { createBusinessFor, signup } from '../helpers/factory';
import { withSystem, withTenant } from '@/server/db/client';
import * as services from '@/app/api/v1/t/[tenantSlug]/services/route';
import * as schedule from '@/app/api/v1/t/[tenantSlug]/staff/[id]/schedule/route';
import * as accounts from '@/app/api/v1/t/[tenantSlug]/payment-accounts/route';
import * as reauth from '@/app/api/v1/auth/reauth/route';
import * as hold from '@/app/api/v1/s/[slug]/bookings/route';
import * as sandboxPay from '@/app/api/v1/sandbox/checkout/[providerPaymentId]/route';
import * as sandboxRefund from '@/app/api/v1/sandbox/refunds/[providerRefundId]/route';
import * as requests from '@/app/api/v1/s/[slug]/event-requests/route';
import * as myRequest from '@/app/api/v1/s/[slug]/event-requests/[id]/route';
import * as accept from '@/app/api/v1/s/[slug]/event-requests/[id]/accept/route';
import * as customerCancel from '@/app/api/v1/s/[slug]/event-requests/[id]/cancel/route';
import * as events from '@/app/api/v1/t/[tenantSlug]/events/route';
import * as eventOne from '@/app/api/v1/t/[tenantSlug]/events/[id]/route';
import * as quote from '@/app/api/v1/t/[tenantSlug]/events/[id]/quote/route';
import * as decline from '@/app/api/v1/t/[tenantSlug]/events/[id]/decline/route';
import * as businessCancel from '@/app/api/v1/t/[tenantSlug]/events/[id]/cancel/route';
import * as balance from '@/app/api/v1/t/[tenantSlug]/events/[id]/balance/route';
import * as complete from '@/app/api/v1/t/[tenantSlug]/events/[id]/complete/route';
import * as eventSettings from '@/app/api/v1/t/[tenantSlug]/event-settings/route';
import { depositFromPercent, eventCancellationRefund } from '@/shared/schemas/events';

/** An independent expert (owner is the provider) working 10:00–22:00, sandbox payments connected. */
async function makeExpert() {
  const owner = await signup('Expert');
  const biz = await createBusinessFor(owner, { business_type: 'expert', plan_code: 'wahaj' });
  const p = { tenantSlug: biz.slug };
  const me = biz.staffProfileId!;
  expect(me).toBeTruthy();
  const week = Array.from({ length: 7 }, (_, d) => ({ weekday: d, start_time: '10:00', end_time: '22:00' }));
  const r = await owner.call(schedule.PUT, { params: { ...p, id: me }, body: { branch_id: biz.branchId, ranges: week, breaks: [] } });
  expect(r.status).toBe(200);
  const svc = await owner.call(services.POST, { params: p, body: { name_ar: 'مكياج سهرة', price_minor: 50000, duration_min: 60, staff: [{ staff_id: me }] } });
  expect(svc.status).toBe(201);
  await owner.call(reauth.POST, { body: { password: 'correct horse battery' } });
  expect((await owner.call(accounts.POST, { params: p, body: { provider: 'sandbox' } })).status).toBe(201);
  await withSystem('test: activate expert', async (trx) => {
    await trx.updateTable('tenants').set({ status: 'active' }).where('id', '=', biz.tenantId).execute();
    await trx.updateTable('tenant_settings').set({ min_notice_min: 0, slot_increment_min: 30 }).where('tenant_id', '=', biz.tenantId).execute();
  });
  return { owner, slug: biz.slug, tenantId: biz.tenantId, me, makeup: svc.body.data.id as string };
}
type Expert = Awaited<ReturnType<typeof makeExpert>>;

async function request(x: Expert, c: Awaited<ReturnType<typeof customer>>, date: string, time = '16:00') {
  const r = await c.call(requests.POST, { params: { slug: x.slug }, idempotencyKey: true, body: {
    occasion: 'wedding', event_date: date, start_time: time, location_type: 'venue', location_text: 'قاعة الياسمين، الرياض', people_count: 4, service_ids: [x.makeup], notes: 'عروس + ٣ مرافقات',
  } });
  expect(r.status).toBe(201);
  return r.body.data.id as string;
}

const quoteBody = { duration_min: 180, prep_before_min: 30, price_minor: 200000, deposit: { mode: 'percent', percent_bp: 3000 } } as const;
const ev = (x: Expert, id: string) => withTenant(x.tenantId, (trx) => trx.selectFrom('event_bookings').selectAll().where('id', '=', id).executeTakeFirstOrThrow());
const allocs = (x: Expert, id: string) => withTenant(x.tenantId, (trx) => trx.selectFrom('booking_allocations').select(['state', 'staff_id', 'expires_at']).where('event_booking_id', '=', id).execute());
const providerRef = (x: Expert, paymentId: string) => withTenant(x.tenantId, (trx) => trx.selectFrom('payments').select('provider_payment_id').where('id', '=', paymentId).executeTakeFirstOrThrow());

async function quoteAndPay(x: Expert, c: Awaited<ReturnType<typeof customer>>, id: string, outcome: 'captured' | 'failed' = 'captured') {
  const q = await x.owner.call(quote.POST, { params: { tenantSlug: x.slug, id }, body: quoteBody });
  expect(q.status).toBe(200);
  const a = await c.call(accept.POST, { params: { slug: x.slug, id }, body: { quote_version: q.body.data.quote_version }, idempotencyKey: true });
  expect(a.status).toBe(201);
  const pp = await providerRef(x, a.body.data.payment.id);
  const done = await c.call(sandboxPay.POST, { params: { providerPaymentId: pp.provider_payment_id! }, body: { outcome } });
  expect(done.body.data.webhook).toBe('processed');
  return { q: q.body.data, a: a.body.data };
}

describe('event bookings with deposit («حجوزات المناسبات»)', () => {
  it('request → quote → deposit via sandbox → confirmed, and the reserved time blocks normal bookings', async () => {
    const x = await makeExpert();
    const c = await customer('Bride');
    const d = futureDate(20);
    const id = await request(x, c, d);

    // The business is notified in-app; the request appears in the workspace list.
    const notes = await withTenant(x.tenantId, (trx) => trx.selectFrom('notifications').select('kind').where('kind', '=', 'event.requested').execute());
    expect(notes).toHaveLength(1);
    const list = await x.owner.call(events.GET, { params: { tenantSlug: x.slug } });
    expect(list.body.data.map((r: { id: string }) => r.id)).toContain(id);

    // Other customers cannot see the request.
    const stranger = await customer('Stranger');
    expect((await stranger.call(myRequest.GET, { params: { slug: x.slug, id } })).status).toBe(404);

    const q = await x.owner.call(quote.POST, { params: { tenantSlug: x.slug, id }, body: quoteBody });
    expect(q.status).toBe(200);
    expect(q.body.data.status).toBe('quoted');
    expect(q.body.data.staff_id).toBe(x.me); // defaults to the expert herself
    const total = q.body.data.total_minor as number;
    expect(q.body.data.deposit_minor).toBe(depositFromPercent(total, 3000));
    const mine = await c.call(myRequest.GET, { params: { slug: x.slug, id } });
    expect(mine.body.data.can_accept).toBe(true);
    expect(mine.body.data).not.toHaveProperty('quoted_by');
    expect((await withTenant(x.tenantId, (trx) => trx.selectFrom('notifications').select('kind').where('kind', '=', 'event.quoted').execute()))).toHaveLength(1);

    // A stale quote version is refused; the customer must accept exactly what she saw.
    expect((await c.call(accept.POST, { params: { slug: x.slug, id }, body: { quote_version: 99 }, idempotencyKey: true })).status).toBe(409);
    const a = await c.call(accept.POST, { params: { slug: x.slug, id }, body: { quote_version: q.body.data.quote_version }, idempotencyKey: true });
    expect(a.status).toBe(201);
    expect(a.body.data.payment.amount_minor).toBe(q.body.data.deposit_minor);
    expect(a.body.data.payment.simulation).toBe(true);
    expect((await ev(x, id)).status).toBe('pending_payment');
    expect((await allocs(x, id)).map((r) => r.state)).toEqual(['held']);

    // While the deposit is being paid, the expert cannot be booked over the event (incl. prep time).
    const other = await customer('Other');
    const clash = await other.call(hold.POST, { params: { slug: x.slug }, body: { items: [{ key: 'x', service_id: x.makeup, staff_id: x.me, start: at(d, '15:30') }] }, idempotencyKey: true });
    expect(clash.status).toBe(409);

    const pp = await providerRef(x, a.body.data.payment.id);
    const done = await c.call(sandboxPay.POST, { params: { providerPaymentId: pp.provider_payment_id! }, body: { outcome: 'captured' } });
    expect(done.body.data.webhook).toBe('processed');
    const e = await ev(x, id);
    expect(e.status).toBe('confirmed');
    expect(e.paid_minor).toBe(q.body.data.deposit_minor);
    expect((await allocs(x, id))).toEqual([{ state: 'confirmed', staff_id: x.me, expires_at: null }]);
    // The deposit is a liability, not revenue.
    const dep = await withTenant(x.tenantId, (trx) => trx.selectFrom('financial_entries').select(['credit_minor']).where('account', '=', 'customer_deposits').where('credit_minor', '>', 0).execute());
    expect(dep.reduce((s, r) => s + Number(r.credit_minor), 0)).toBe(q.body.data.deposit_minor);
    const confirmedNote = await withTenant(x.tenantId, (trx) => trx.selectFrom('notifications').select(['user_id', 'kind']).where('kind', '=', 'event.confirmed').execute());
    expect(confirmedNote.length).toBeGreaterThanOrEqual(2); // customer + business

    // Normal availability respects the event: 17:00 is inside 15:30–19:00.
    const blocked = await other.call(hold.POST, { params: { slug: x.slug }, body: { items: [{ key: 'x', service_id: x.makeup, staff_id: x.me, start: at(d, '17:00') }] }, idempotencyKey: true });
    expect(blocked.status).toBe(409);
    const free = await other.call(hold.POST, { params: { slug: x.slug }, body: { items: [{ key: 'x', service_id: x.makeup, staff_id: x.me, start: at(d, '19:00') }] }, idempotencyKey: true });
    expect(free.status).toBe(201);

    // On the day: balance collected at the venue, then completed → revenue recognised.
    const due = total - e.paid_minor;
    expect((await x.owner.call(balance.POST, { params: { tenantSlug: x.slug, id }, body: { amount_minor: due + 1, method: 'cash', reference: 'R-1' }, idempotencyKey: true })).status).toBe(422);
    const bal = await x.owner.call(balance.POST, { params: { tenantSlug: x.slug, id }, body: { amount_minor: due, method: 'cash', reference: 'R-1' }, idempotencyKey: true });
    expect(bal.status).toBe(201);
    expect((await x.owner.call(complete.POST, { params: { tenantSlug: x.slug, id } })).status).toBe(409); // not started yet
    await withSystem('test: move event to the past', (trx) => trx.updateTable('event_bookings').set({ starts_at: sql`now() - interval '4 hours'`, ends_at: sql`now() - interval '1 hour'` }).where('id', '=', id).execute());
    const done2 = await x.owner.call(complete.POST, { params: { tenantSlug: x.slug, id } });
    expect(done2.status).toBe(200);
    expect(done2.body.data.status).toBe('completed');
    const journal = await withTenant(x.tenantId, (trx) => trx.selectFrom('financial_entries').select([sql<number>`sum(debit_minor)::bigint`.as('dr'), sql<number>`sum(credit_minor)::bigint`.as('cr')]).executeTakeFirstOrThrow());
    expect(Number(journal.dr)).toBe(Number(journal.cr));
    const revenue = await withTenant(x.tenantId, (trx) => trx.selectFrom('financial_entries').select('credit_minor').where('ref_type', '=', 'event_completion').where('account', 'in', ['service_revenue', 'tax_payable']).execute());
    expect(revenue.reduce((s, r) => s + Number(r.credit_minor), 0)).toBe(total);

    const detail = await x.owner.call(eventOne.GET, { params: { tenantSlug: x.slug, id } });
    expect(detail.body.data.payments).toHaveLength(2);
    expect(detail.body.data.balance_due_minor).toBe(0);
  });

  it('a failed checkout frees the held time and the quote can be accepted again', async () => {
    const x = await makeExpert();
    const c = await customer();
    const id = await request(x, c, futureDate(15));
    const { q } = await quoteAndPay(x, c, id, 'failed');
    expect((await ev(x, id)).status).toBe('quoted');
    expect((await allocs(x, id)).map((r) => r.state)).toEqual(['released']);
    const again = await c.call(accept.POST, { params: { slug: x.slug, id }, body: { quote_version: q.quote_version }, idempotencyKey: true });
    expect(again.status).toBe(201);
  });

  it('customer cancellation follows the quoted policy: deposit retained inside the window, refunded outside it', async () => {
    const x = await makeExpert();
    // Policy at quote time: free cancellation up to 30 days before. The event is 10 days ahead.
    expect((await x.owner.call(eventSettings.PUT, { params: { tenantSlug: x.slug }, body: { free_cancellation_days: 30 } })).status).toBe(200);
    const c = await customer();
    const d = futureDate(10);
    const id = await request(x, c, d);
    const { q } = await quoteAndPay(x, c, id);
    // A later policy change does not affect this booking (snapshot).
    await x.owner.call(eventSettings.PUT, { params: { tenantSlug: x.slug }, body: { free_cancellation_days: 0 } });
    const cancel = await c.call(customerCancel.POST, { params: { slug: x.slug, id }, body: { reason: 'تغيّر موعد الزواج' } });
    expect(cancel.status).toBe(200);
    expect(cancel.body.data).toMatchObject({ status: 'cancelled', refund_minor: 0, retained_minor: q.deposit_minor, basis: 'deposit_retained' });
    expect((await allocs(x, id)).map((r) => r.state)).toEqual(['released']);
    const retained = await withTenant(x.tenantId, (trx) => trx.selectFrom('financial_entries').select('credit_minor').where('ref_type', '=', 'event_retained').where('account', '=', 'service_revenue').execute());
    expect(Number(retained[0]!.credit_minor)).toBe(q.deposit_minor);
    // The freed time is bookable again.
    const other = await customer();
    expect((await other.call(hold.POST, { params: { slug: x.slug }, body: { items: [{ key: 'x', service_id: x.makeup, staff_id: x.me, start: at(d, '17:00') }] }, idempotencyKey: true })).status).toBe(201);
    // Cannot cancel twice.
    expect((await c.call(customerCancel.POST, { params: { slug: x.slug, id }, body: { reason: 'again!' } })).status).toBe(409);

    // Outside the window (policy 0 days now applies to the next quote): full refund.
    const id2 = await request(x, c, futureDate(12), '11:00');
    await quoteAndPay(x, c, id2);
    const c2 = await c.call(customerCancel.POST, { params: { slug: x.slug, id: id2 }, body: { reason: 'cannot make it' } });
    expect(c2.body.data.basis).toBe('free_window');
    expect(c2.body.data.refund_minor).toBe((await ev(x, id2)).paid_minor);
  });

  it('business cancellation refunds everything; the refund lands on provider confirmation', async () => {
    const x = await makeExpert();
    const c = await customer();
    const id = await request(x, c, futureDate(25));
    const { a } = await quoteAndPay(x, c, id);
    const r = await x.owner.call(businessCancel.POST, { params: { tenantSlug: x.slug, id }, body: { reason: 'ظرف طارئ' } });
    expect(r.status).toBe(200);
    expect(r.body.data.refund_minor).toBe(a.payment.amount_minor);
    const rf = await withTenant(x.tenantId, (trx) => trx.selectFrom('refunds').select(['provider_refund_id', 'status', 'amount_minor']).where('payment_id', '=', a.payment.id).executeTakeFirstOrThrow());
    expect(rf.status).toBe('pending');
    expect((await ev(x, id)).refunded_minor).toBe(0); // pending is not refunded
    await c.call(sandboxRefund.POST, { params: { providerRefundId: rf.provider_refund_id! }, body: { outcome: 'succeeded' } });
    expect((await ev(x, id)).refunded_minor).toBe(a.payment.amount_minor);
    const n = await withTenant(x.tenantId, (trx) => trx.selectFrom('notifications').select('kind').where('kind', '=', 'event.cancelled').execute());
    expect(n).toHaveLength(1);
  });

  it('validates requests and lets the business decline; quotes cannot overlap other commitments', async () => {
    const x = await makeExpert();
    const c = await customer();
    const bad = await c.call(requests.POST, { params: { slug: x.slug }, idempotencyKey: true, body: { occasion: 'wedding', event_date: futureDate(5), start_time: '16:00', location_type: 'venue', people_count: 3 } });
    expect(bad.status).toBe(422); // venue needs a location
    const past = await c.call(requests.POST, { params: { slug: x.slug }, idempotencyKey: true, body: { occasion: 'party', event_date: futureDate(-2), start_time: '16:00', location_type: 'studio', people_count: 3 } });
    expect(past.status).toBe(422);
    const many = await c.call(requests.POST, { params: { slug: x.slug }, idempotencyKey: true, body: { occasion: 'group_makeup', event_date: futureDate(5), start_time: '16:00', location_type: 'studio', people_count: 400 } });
    expect(many.body.error.code).toBe('too_many_people');

    const d = futureDate(9);
    const id = await request(x, c, d);
    const declined = await x.owner.call(decline.POST, { params: { tenantSlug: x.slug, id }, body: { reason: 'محجوزة ذلك اليوم' } });
    expect(declined.body.data.status).toBe('declined');
    expect((await c.call(accept.POST, { params: { slug: x.slug, id }, body: { quote_version: 1 }, idempotencyKey: true })).status).toBe(409);

    // A confirmed booking at 16:00 means a quote over it is refused.
    const other = await customer();
    expect((await other.call(hold.POST, { params: { slug: x.slug }, body: { items: [{ key: 'x', service_id: x.makeup, staff_id: x.me, start: at(d, '17:00') }] }, idempotencyKey: true })).status).toBe(201);
    const id2 = await request(x, c, d);
    const q = await x.owner.call(quote.POST, { params: { tenantSlug: x.slug, id: id2 }, body: quoteBody });
    expect(q.status).toBe(409);
    expect(q.body.error.code).toBe('slot_unavailable');
  });
});

describe('event cancellation policy (pure)', () => {
  const base = { paidMinor: 6000, refundedMinor: 0, depositMinor: 6000, startsAt: new Date('2027-01-10T12:00:00Z'), freeCancellationDays: 7 };
  it('business cancellations always refund in full', () => {
    expect(eventCancellationRefund({ ...base, by: 'business', now: new Date('2027-01-10T11:00:00Z') })).toEqual({ refundMinor: 6000, retainedMinor: 0, basis: 'business_cancelled' });
  });
  it('customer: free window, then deposit retained (extra payments still refunded)', () => {
    expect(eventCancellationRefund({ ...base, by: 'customer', now: new Date('2027-01-02T12:00:00Z') }).basis).toBe('free_window');
    expect(eventCancellationRefund({ ...base, paidMinor: 10000, by: 'customer', now: new Date('2027-01-05T12:00:00Z') })).toEqual({ refundMinor: 4000, retainedMinor: 6000, basis: 'deposit_retained' });
  });
  it('nothing paid, nothing to refund', () => {
    expect(eventCancellationRefund({ ...base, paidMinor: 0, by: 'customer', now: new Date('2027-01-05T12:00:00Z') }).basis).toBe('nothing_paid');
  });
});
