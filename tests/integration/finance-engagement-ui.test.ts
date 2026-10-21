import { describe, expect, it } from 'vitest';
import { at, customer, futureDate, makeSalon, type Salon } from '../helpers/salon';
import { withTenant } from '@/server/db/client';
import * as hold from '@/app/api/v1/s/[slug]/bookings/route';
import * as checkout from '@/app/api/v1/s/[slug]/bookings/[id]/checkout/route';
import * as onSite from '@/app/api/v1/t/[tenantSlug]/payments/on-site/route';
import * as report from '@/app/api/v1/t/[tenantSlug]/finance/report/route';
import * as rules from '@/app/api/v1/t/[tenantSlug]/finance/commission-rules/route';
import * as commissions from '@/app/api/v1/t/[tenantSlug]/finance/commissions/route';
import * as reverse from '@/app/api/v1/t/[tenantSlug]/finance/commissions/[id]/reverse/route';
import * as exportsRoute from '@/app/api/v1/t/[tenantSlug]/finance/exports/route';
import * as receipts from '@/app/api/v1/t/[tenantSlug]/finance/receipts/route';
import * as join from '@/app/api/v1/s/[slug]/waitlist/route';
import * as waitlist from '@/app/api/v1/t/[tenantSlug]/waitlist/route';
import * as offer from '@/app/api/v1/account/waitlist/offers/[id]/route';
import * as accountBooking from '@/app/api/v1/account/bookings/[id]/route';
import * as accountReceipt from '@/app/api/v1/account/bookings/[id]/receipts/[receiptId]/route';
import * as accountCancel from '@/app/api/v1/account/bookings/[id]/cancel/route';
import * as loyalty from '@/app/api/v1/t/[tenantSlug]/loyalty/route';
import * as rewards from '@/app/api/v1/t/[tenantSlug]/loyalty/rewards/route';
import * as reward from '@/app/api/v1/t/[tenantSlug]/loyalty/rewards/[id]/route';
import * as adjust from '@/app/api/v1/t/[tenantSlug]/loyalty/adjust/route';
import * as loyaltyCustomer from '@/app/api/v1/t/[tenantSlug]/loyalty/customers/[id]/route';
import * as plans from '@/app/api/v1/t/[tenantSlug]/membership-plans/route';
import * as plan from '@/app/api/v1/t/[tenantSlug]/membership-plans/[id]/route';
import * as memberships from '@/app/api/v1/t/[tenantSlug]/memberships/route';
import { transition } from '@/server/domains/booking/service';
import { resolveTenantAccess } from '@/server/tenancy/access';
import { resolveSession } from '@/server/auth/service';

async function bookOnSite(s: Salon, start: string, c?: Awaited<ReturnType<typeof customer>>) {
  const who = c ?? (await customer());
  const h = await who.call(hold.POST, { params: { slug: s.slug }, body: { items: [{ key: 'x', service_id: s.services.haircut, staff_id: s.staff.sara, start }] }, idempotencyKey: true });
  expect(h.status).toBe(201);
  await who.call(checkout.POST, { params: { slug: s.slug, id: h.body.data.booking_id }, body: { option: 'on_site' }, idempotencyKey: true });
  return { c: who, id: h.body.data.booking_id as string };
}

async function complete(s: Salon, id: string) {
  const user = await resolveSession(s.owner.cookies.get('luma_session'));
  const access = await resolveTenantAccess(user!, s.slug);
  const b = await withTenant(s.tenantId, (trx) => trx.selectFrom('bookings').select('starts_at').where('id', '=', id).executeTakeFirstOrThrow());
  const now = new Date(b.starts_at.getTime() + 60_000);
  const actor = { kind: 'staff' as const, access, audit: { userId: user!.userId, kind: 'user' as const } };
  await transition(s.tenantId, id, 'check_in', actor, { now });
  await transition(s.tenantId, id, 'complete', actor, { now });
}

describe('finance UI read models', () => {
  it('lists commission entries with names, reversals, export history, a daily series and the configured tax', async () => {
    const s = await makeSalon();
    const p = { tenantSlug: s.slug };
    const rule = await s.owner.call(rules.POST, { params: p, body: { kind: 'percent', rate_bp: 1000, staff_id: s.staff.sara } });
    expect(rule.status).toBe(201);
    const listed = await s.owner.call(rules.GET, { params: p });
    expect(listed.body.data[0].staff_name).toBe('Sara');

    const d = futureDate(2);
    const { id } = await bookOnSite(s, at(d, '10:00'));
    const pay = await s.owner.call(onSite.POST, { params: p, body: { booking_id: id, amount_minor: 10000, method: 'cash', reference: 'C-1' }, idempotencyKey: true });
    expect(pay.status).toBe(201);
    await complete(s, id);
    const today = futureDate(0);
    const range = { from: today, to: futureDate(3) };
    const entries = await s.owner.call(commissions.GET, { params: p, query: range });
    expect(entries.status).toBe(200);
    expect(entries.body.data).toHaveLength(1);
    const e = entries.body.data[0];
    expect(e).toMatchObject({ kind: 'earned', staff_name: 'Sara', reversed: false, booking_id: id });
    expect(e.amount_minor).toBeGreaterThan(0);
    expect((await s.owner.call(reverse.POST, { params: { ...p, id: e.id }, body: { reason: 'refund correction' } })).status).toBe(200);
    const after = await s.owner.call(commissions.GET, { params: p, query: range });
    expect(after.body.data.map((x: any) => x.kind).sort()).toEqual(['earned', 'reversal']);
    expect(after.body.data.find((x: any) => x.kind === 'earned').reversed).toBe(true);

    const r = await s.owner.call(report.GET, { params: p, query: range });
    expect(r.body.data.daily).toHaveLength(4);
    expect(r.body.data.daily.reduce((a: number, x: any) => a + x.collections_minor, 0)).toBe(r.body.data.collections.total_minor);
    expect(r.body.data.tax.configured).toHaveProperty('tax_rate_bp');

    expect((await s.owner.call(exportsRoute.GET, { params: p })).body.data).toEqual([]);
    const ex = await s.owner.call(exportsRoute.POST, { params: p, body: { kind: 'bookings', ...range } });
    expect(ex.status).toBe(201);
    const hist = await s.owner.call(exportsRoute.GET, { params: p });
    expect(hist.body.data).toHaveLength(1);
    expect(hist.body.data[0]).toMatchObject({ kind: 'bookings', status: 'succeeded', download_url: ex.body.data.download_url });
    expect(hist.body.data[0]).not.toHaveProperty('asset_id');
    // Customers never reach the finance read models.
    const c = await customer();
    expect((await c.call(commissions.GET, { params: p, query: range })).status).toBe(404);
  });
});

describe('customer booking detail', () => {
  it('shows her own booking with snapshot terms, a refund preview equal to the real cancellation, and her receipts', async () => {
    const s = await makeSalon({ settings: { free_cancellation_hours: 24, late_cancellation_fee_bp: 5000 } });
    const { c, id } = await bookOnSite(s, at(futureDate(5), '11:00'));
    const pay = await s.owner.call(onSite.POST, { params: { tenantSlug: s.slug }, body: { booking_id: id, amount_minor: 10000, method: 'cash', reference: 'D-1' }, idempotencyKey: true });
    const rc = await s.owner.call(receipts.POST, { params: { tenantSlug: s.slug }, body: { payment_id: pay.body.data.payment_id } });
    const r = await c.call(accountBooking.GET, { params: { id } });
    expect(r.status).toBe(200);
    const b = r.body.data;
    expect(b.tenant.slug).toBe(s.slug);
    expect(b.items[0]).toMatchObject({ service_id: s.services.haircut, staff_id: s.staff.sara, addon_ids: [] });
    expect(b.terms).toMatchObject({ free_cancellation_hours: 24, late_cancellation_fee_bp: 5000 });
    expect(b.actions).toMatchObject({ can_cancel: true, can_reschedule: true, checkout_path: null });
    expect(b.actions.cancellation_preview).toEqual({ refund_minor: 10000, fee_minor: 0, basis: 'free_window' });
    expect(b.receipts.map((x: any) => x.id)).toEqual([rc.body.data.id]);
    const html = await c.call(accountReceipt.GET, { params: { id, receiptId: rc.body.data.id } });
    expect(html.status).toBe(200);
    expect(String(html.body)).toContain('<!doctype html>');
    // Another customer sees nothing.
    const other = await customer('Other');
    expect((await other.call(accountBooking.GET, { params: { id } })).status).toBe(404);
    expect((await other.call(accountReceipt.GET, { params: { id, receiptId: rc.body.data.id } })).status).toBe(404);
    // The preview matches what the cancellation actually does.
    const cancel = await c.call(accountCancel.POST, { params: { id }, body: { reason: 'plans changed' } });
    expect(cancel.body.data.refund_due_minor).toBe(b.actions.cancellation_preview.refund_minor);
    const closed = await c.call(accountBooking.GET, { params: { id } });
    expect(closed.body.data.actions).toMatchObject({ can_cancel: false, can_reschedule: false, cancellation_preview: null });
  });

  it('links a pending hold to its payment page', async () => {
    const s = await makeSalon();
    const c = await customer();
    const h = await c.call(hold.POST, { params: { slug: s.slug }, body: { items: [{ key: 'x', service_id: s.services.haircut, staff_id: s.staff.sara, start: at(futureDate(4), '12:00') }] }, idempotencyKey: true });
    const r = await c.call(accountBooking.GET, { params: { id: h.body.data.booking_id } });
    expect(r.body.data.actions.checkout_path).toBe(`/s/${s.slug}/checkout/booking/${h.body.data.booking_id}`);
  });
});

describe('waitlist offers for the dashboard and the customer', () => {
  it('shows the offered slot and expiry, notifies with a link to the offer page, and keeps offers private', async () => {
    const s = await makeSalon();
    const d = futureDate(5);
    const { c: a, id } = await bookOnSite(s, at(d, '10:00'));
    const b = await customer('B');
    expect((await b.call(join.POST, { params: { slug: s.slug }, body: { service_id: s.services.haircut, staff_id: s.staff.sara, desired_from: d, desired_to: d, notify_consent: true } })).status).toBe(201);
    let list = await s.owner.call(waitlist.GET, { params: { tenantSlug: s.slug } });
    expect(list.body.data[0]).toMatchObject({ status: 'active', staff_name: 'Sara', latest_offer: null });
    await a.call(accountCancel.POST, { params: { id }, body: { reason: 'cannot come' } });
    list = await s.owner.call(waitlist.GET, { params: { tenantSlug: s.slug } });
    const entry = list.body.data[0];
    expect(entry.status).toBe('offered');
    expect(entry.latest_offer).toMatchObject({ status: 'pending', staff_name: 'Sara' });
    expect(new Date(entry.latest_offer.slot_start).toISOString()).toBe(new Date(at(d, '10:00')).toISOString());
    const offerId = entry.latest_offer.id;
    const note = await withTenant(s.tenantId, (trx) => trx.selectFrom('notifications').select('target_path').where('kind', '=', 'waitlist.offer').executeTakeFirstOrThrow());
    expect(note.target_path).toBe(`/account/waitlist/offers/${offerId}`);
    const mine = await b.call(offer.GET, { params: { id: offerId } });
    expect(mine.status).toBe(200);
    expect(mine.body.data).toMatchObject({ id: offerId, status: 'pending', tenant_slug: s.slug, staff_name: 'Sara' });
    expect((await a.call(offer.GET, { params: { id: offerId } })).status).toBe(404);
  });
});

describe('loyalty and membership management', () => {
  it('looks up a customer balance, adjusts it with a reason, edits rewards and plans for future sales', async () => {
    const s = await makeSalon();
    const p = { tenantSlug: s.slug };
    const lp = await s.owner.call(loyalty.GET, { params: p });
    await s.owner.call(loyalty.PUT, { params: p, body: { is_enabled: true, points_per_currency_unit: 1, points_expiry_days: null, tiers: [], reverse_on_refund: true, version: lp.body.data.program.version } });
    const { id } = await bookOnSite(s, at(futureDate(3), '13:00'));
    const tc = (await withTenant(s.tenantId, (trx) => trx.selectFrom('bookings').select('tenant_customer_id').where('id', '=', id).executeTakeFirstOrThrow())).tenant_customer_id;
    const empty = await s.owner.call(loyaltyCustomer.GET, { params: { ...p, id: tc } });
    expect(empty.body.data).toMatchObject({ balance: 0, entries: [] });
    expect(empty.body.data.customer.id).toBe(tc);
    expect((await s.owner.call(adjust.POST, { params: p, body: { customer_id: tc, delta: 25, reason: 'welcome gift' } })).status).toBe(200);
    const after = await s.owner.call(loyaltyCustomer.GET, { params: { ...p, id: tc } });
    expect(after.body.data.balance).toBe(25);
    expect(after.body.data.entries[0]).toMatchObject({ kind: 'adjust', delta: 25, reason: 'welcome gift' });

    const rw = await s.owner.call(rewards.POST, { params: p, body: { name_ar: 'خصم', points_cost: 100, kind: 'fixed_discount', value: 1000 } });
    const off = await s.owner.call(reward.PATCH, { method: 'PATCH', params: { ...p, id: rw.body.data.id }, body: { is_active: false, points_cost: 120 } });
    expect(off.body.data).toMatchObject({ is_active: false, points_cost: 120 });
    expect((await s.owner.call(reward.PATCH, { method: 'PATCH', params: { ...p, id: rw.body.data.id }, body: { name_ar: null } })).status).toBe(422);

    const pl = await s.owner.call(plans.POST, { params: p, body: { name_ar: 'باقة', price_minor: 20000, validity_days: 30, items: [{ service_id: s.services.haircut, sessions: 2 }] } });
    const sold = await s.owner.call(memberships.POST, { params: p, body: { customer_id: tc, plan_id: pl.body.data.id, method: 'cash', reference: 'M-9' }, idempotencyKey: true });
    expect(sold.status).toBe(201);
    const ed = await s.owner.call(plan.PATCH, { method: 'PATCH', params: { ...p, id: pl.body.data.id }, body: { price_minor: 25000, is_visible: false } });
    expect(ed.body.data).toMatchObject({ price_minor: 25000, is_visible: false });
    // Recent sales across customers keep the price they were sold at.
    const recent = await s.owner.call(memberships.GET, { params: p });
    expect(recent.body.data).toHaveLength(1);
    expect(recent.body.data[0]).toMatchObject({ price_paid_minor: 20000, tenant_customer_id: tc });
    expect(recent.body.data[0].customer_name).toBeTruthy();
    expect(recent.body.data[0].entitlements[0]).toMatchObject({ total: 2, remaining: 2 });
  });
});
