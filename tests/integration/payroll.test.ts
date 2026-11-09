import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { at, customer, futureDate, makeSalon, TZ, type Salon } from '../helpers/salon';
import { signup } from '../helpers/factory';
import { addToCart, checkout as orderCheckout, createProduct } from '../helpers/commerce';
import { withTenant } from '@/server/db/client';
import { markOrderPaid } from '@/server/domains/commerce';
import * as hold from '@/app/api/v1/s/[slug]/bookings/route';
import * as checkout from '@/app/api/v1/s/[slug]/bookings/[id]/checkout/route';
import * as onSite from '@/app/api/v1/t/[tenantSlug]/payments/on-site/route';
import * as report from '@/app/api/v1/t/[tenantSlug]/finance/report/route';
import * as invitations from '@/app/api/v1/t/[tenantSlug]/invitations/route';
import * as accept from '@/app/api/v1/invitations/accept/route';
import * as policy from '@/app/api/v1/t/[tenantSlug]/payroll/commission-policy/route';
import * as seller from '@/app/api/v1/t/[tenantSlug]/orders/[id]/seller/route';
import * as salary from '@/app/api/v1/t/[tenantSlug]/payroll/salaries/[staffId]/route';
import * as salaries from '@/app/api/v1/t/[tenantSlug]/payroll/salaries/route';
import * as entries from '@/app/api/v1/t/[tenantSlug]/payroll/entries/route';
import * as voidEntry from '@/app/api/v1/t/[tenantSlug]/payroll/entries/[id]/void/route';
import * as tips from '@/app/api/v1/t/[tenantSlug]/payroll/tips/route';
import * as sheet from '@/app/api/v1/t/[tenantSlug]/payroll/sheet/route';
import * as close from '@/app/api/v1/t/[tenantSlug]/payroll/close/route';
import * as pay from '@/app/api/v1/t/[tenantSlug]/payroll/slips/[id]/pay/route';
import * as slip from '@/app/api/v1/t/[tenantSlug]/payroll/slips/[id]/route';
import * as earnings from '@/app/api/v1/t/[tenantSlug]/me/earnings/route';
import { transition } from '@/server/domains/booking/service';
import { resolveTenantAccess } from '@/server/tenancy/access';
import { resolveSession } from '@/server/auth/service';

const now = () => DateTime.now().setZone(TZ);
const thisMonth = () => now().toFormat('yyyy-MM');
const nextMonth = () => now().plus({ months: 1 }).toFormat('yyyy-MM');
const today = () => now().toISODate()!;

/** Books a service on site, takes payment and completes it now. */
async function serve(s: Salon, serviceId: string, staffId: string, daysAhead: number, hhmm = '10:00') {
  const c = await customer();
  const h = await c.call(hold.POST, { params: { slug: s.slug }, body: { items: [{ key: 'x', service_id: serviceId, staff_id: staffId, start: at(futureDate(daysAhead), hhmm) }] }, idempotencyKey: true });
  expect(h.status).toBe(201);
  const id = h.body.data.booking_id as string;
  await c.call(checkout.POST, { params: { slug: s.slug, id }, body: { option: 'on_site' }, idempotencyKey: true });
  const b = await withTenant(s.tenantId, (trx) => trx.selectFrom('bookings').select(['starts_at', 'total_minor']).where('id', '=', id).executeTakeFirstOrThrow());
  await s.owner.call(onSite.POST, { params: { tenantSlug: s.slug }, body: { booking_id: id, amount_minor: b.total_minor, method: 'cash', reference: 'R-1' }, idempotencyKey: true });
  const user = await resolveSession(s.owner.cookies.get('luma_session'));
  const access = await resolveTenantAccess(user!, s.slug);
  const actor = { kind: 'staff' as const, access, audit: { userId: user!.userId, kind: 'user' as const } };
  const when = new Date(b.starts_at.getTime() + 60_000);
  await transition(s.tenantId, id, 'check_in', actor, { now: when });
  await transition(s.tenantId, id, 'complete', actor, { now: when });
  return id;
}

/** A paid product order of 100 SAR. */
async function paidOrder(s: Salon) {
  const prod = await createProduct(s.owner, s.slug, {}, { price_minor: 10000, initial_stock: 5 });
  const c = await signup('Shopper');
  await addToCart(c, s.slug, prod.variants[0]!.id, 1);
  const o = await orderCheckout(c, s.slug);
  expect(o.status).toBe(201);
  const id = o.body.data.id as string;
  await withTenant(s.tenantId, (trx) => markOrderPaid(trx, s.tenantId, id, { paymentId: crypto.randomUUID(), amountMinor: o.body.data.total_minor }));
  return id;
}

async function member(s: Salon, role: 'specialist' | 'receptionist' | 'finance', staffProfileId?: string) {
  const m = await signup(role);
  const inv = await s.owner.call(invitations.POST, { params: { tenantSlug: s.slug }, body: { identifier: m.identifier, role, ...(staffProfileId ? { staff_profile_id: staffProfileId } : {}) } });
  expect(inv.status).toBe(201);
  const token = inv.body.data.dev_invite_link.split('/invite/')[1];
  expect((await m.call(accept.POST, { body: { token } })).status).toBe(200);
  return m;
}

const rowOf = async (s: Salon, staffId: string, month = thisMonth()) =>
  (await s.owner.call(sheet.GET, { params: { tenantSlug: s.slug }, query: { month } })).body.data.rows.find((r: any) => r.staff_id === staffId);

describe('commission decided by the business per category (services, products) with tiers', () => {
  it('starts off, applies the rate and the reached tier to all monthly sales, and pays product commission to the recorded seller', async () => {
    const s = await makeSalon();
    const p = { tenantSlug: s.slug };
    const initial = (await s.owner.call(policy.GET, { params: p })).body.data;
    expect(initial).toMatchObject({ services: { enabled: false }, products: { enabled: false } });

    await serve(s, s.services.haircut, s.staff.sara, 2);
    expect(await rowOf(s, s.staff.sara)).toMatchObject({ service_sales_minor: 10000, service_count: 1, service_rate_bp: 0, service_commission_minor: 0 });

    // Services: 10%, and 20% on everything once monthly sales reach 150 SAR.
    const set = await s.owner.call(policy.PATCH, { method: 'PATCH', params: p, body: { services: { enabled: true, rate_bp: 1000, tiers: [{ threshold_minor: 15000, rate_bp: 2000 }] } } });
    expect(set.status).toBe(200);
    expect(await rowOf(s, s.staff.sara)).toMatchObject({ service_rate_bp: 1000, service_commission_minor: 1000 });
    await serve(s, s.services.color, s.staff.sara, 3);
    expect(await rowOf(s, s.staff.sara)).toMatchObject({ service_sales_minor: 40000, service_count: 2, service_rate_bp: 2000, service_commission_minor: 8000 });
    const bad = await s.owner.call(policy.PATCH, { method: 'PATCH', params: p, body: { services: { enabled: true, rate_bp: 1000, tiers: [{ threshold_minor: 20000, rate_bp: 2000 }, { threshold_minor: 10000, rate_bp: 3000 }] } } });
    expect(bad.status).toBe(422);

    // Products: no commission until switched on; it goes to the seller on the order.
    const order = await paidOrder(s);
    expect((await s.owner.call(seller.PUT, { method: 'PUT', params: { ...p, id: order }, body: { staff_id: s.staff.huda } })).status).toBe(200);
    expect(await rowOf(s, s.staff.huda)).toMatchObject({ product_sales_minor: 10000, product_count: 1, product_commission_minor: 0 });
    await s.owner.call(policy.PATCH, { method: 'PATCH', params: p, body: { products: { enabled: true, rate_bp: 500, tiers: [] } } });
    expect(await rowOf(s, s.staff.huda)).toMatchObject({ product_rate_bp: 500, product_commission_minor: 500, commission_minor: 500 });

    // Once the month is closed the seller can no longer change.
    expect((await s.owner.call(close.POST, { params: p, body: { month: thisMonth() } })).status).toBe(201);
    expect((await s.owner.call(seller.PUT, { method: 'PUT', params: { ...p, id: order }, body: { staff_id: s.staff.sara } })).body.error.code).toBe('order_commission_settled');
    const frozen = await rowOf(s, s.staff.sara);
    expect(frozen).toMatchObject({ service_rate_bp: 2000, service_commission_minor: 8000, commission_minor: 8000 });
    // Commission expense is posted at close and reported.
    const r = (await s.owner.call(report.GET, { params: p, query: { from: `${thisMonth()}-01`, to: futureDate(0) } })).body.data;
    expect(r.commissions.amount_minor).toBe(8500);
  });
});

describe('payroll', () => {
  it('pro-rates salary by employment dates, repays advances in instalments, pays from the bank, closes once and carries forward', async () => {
    const s = await makeSalon();
    const p = { tenantSlug: s.slug };
    const dim = now().daysInMonth!;
    const startDay = `${thisMonth()}-11`;
    expect((await s.owner.call(salary.PUT, { method: 'PUT', params: { ...p, staffId: s.staff.sara }, body: { base_salary_minor: 300000, employment_start: startDay } })).status).toBe(200);
    expect((await s.owner.call(salary.PUT, { method: 'PUT', params: { ...p, staffId: s.staff.huda }, body: { base_salary_minor: 250000 } })).status).toBe(200);
    expect((await s.owner.call(salary.PUT, { method: 'PUT', params: { ...p, staffId: s.staff.huda }, body: { base_salary_minor: 250000, employment_start: `${thisMonth()}-20`, employment_end: `${thisMonth()}-01` } })).status).toBe(422);
    expect((await s.owner.call(salaries.GET, { params: p })).body.data.find((x: any) => x.staff_id === s.staff.sara)).toMatchObject({ base_salary_minor: 300000, employment_start: startDay });

    const booking = await serve(s, s.services.haircut, s.staff.sara, 2);
    expect((await s.owner.call(tips.POST, { params: p, body: { booking_id: booking, staff_id: s.staff.huda, amount_minor: 5000, method: 'cash' } })).body.error.code).toBe('tip_staff_not_on_booking');
    expect((await s.owner.call(tips.POST, { params: p, body: { booking_id: booking, staff_id: s.staff.sara, amount_minor: 5000, method: 'cash' } })).status).toBe(201);
    const add = (body: Record<string, unknown>) => s.owner.call(entries.POST, { params: p, body: { staff_id: s.staff.sara, effective_on: today(), ...body } });
    expect((await add({ kind: 'bonus', amount_minor: 10000 })).status).toBe(201);
    expect((await add({ kind: 'deduction', amount_minor: 2000 })).status).toBe(201);
    expect((await add({ kind: 'bonus', amount_minor: 1000, installments: 3 })).body.error.code).toBe('installments_only_for_advances');
    const adv = await add({ kind: 'advance', amount_minor: 90001, installments: 3, method: 'bank_transfer' });
    expect(adv.status).toBe(201);
    const advPost = await withTenant(s.tenantId, (trx) => trx.selectFrom('financial_entries').select(['account', 'debit_minor', 'credit_minor']).where('ref_type', '=', 'payroll_advance').execute());
    expect(advPost).toEqual(expect.arrayContaining([{ account: 'staff_advances', debit_minor: 90001, credit_minor: 0 }, { account: 'bank', debit_minor: 0, credit_minor: 90001 }]));

    const sara = await rowOf(s, s.staff.sara);
    const days = dim - 10;
    expect(sara).toMatchObject({ base_full_minor: 300000, days_employed: days, days_in_month: dim, base_minor: Math.round((300000 * days) / dim), tips_minor: 5000, bonus_minor: 10000, deduction_minor: 2000, advance_minor: 30000 });
    expect(sara.entries.find((e: any) => e.kind === 'advance').installment).toEqual({ index: 1, of: 3 });
    expect(sara.net_minor).toBe(sara.base_minor + 5000 + 10000 - 2000 - 30000);
    expect(sara).not.toHaveProperty('settle');
    expect((await rowOf(s, s.staff.huda)).base_minor).toBe(250000);

    // Close: once, balanced journal.
    expect((await s.owner.call(close.POST, { params: p, body: { month: thisMonth() } })).status).toBe(201);
    expect((await s.owner.call(close.POST, { params: p, body: { month: thisMonth() } })).body.error.code).toBe('payroll_already_closed');
    const lines = await withTenant(s.tenantId, (trx) => trx.selectFrom('financial_entries').select(['account', 'debit_minor', 'credit_minor']).where('ref_type', '=', 'payroll_close').execute());
    expect(lines.reduce((a, l) => a + l.debit_minor - l.credit_minor, 0)).toBe(0);
    expect(lines.find((l) => l.account === 'staff_advances')!.credit_minor).toBe(30000);
    const saraSlip = await rowOf(s, s.staff.sara);
    expect(saraSlip.number).toMatch(/^PAY-\d{6}$/);
    expect(saraSlip.net_minor).toBe(sara.net_minor);

    // The advance cannot be voided once an instalment is settled; the next month takes instalment 2.
    expect((await s.owner.call(voidEntry.POST, { params: { ...p, id: adv.body.data.id }, body: { reason: 'try to undo' } })).body.error.code).toBe('payroll_entry_settled');
    expect((await s.owner.call(salary.PUT, { method: 'PUT', params: { ...p, staffId: s.staff.huda }, body: { base_salary_minor: 250000, employment_end: `${nextMonth()}-15` } })).status).toBe(200);
    const dimNext = now().plus({ months: 1 }).daysInMonth!;
    const nextSara = await rowOf(s, s.staff.sara, nextMonth());
    expect(nextSara).toMatchObject({ base_minor: 300000, days_employed: dimNext, advance_minor: 30000, commission_minor: 0, tips_minor: 0 });
    expect(nextSara.entries[0].installment).toEqual({ index: 2, of: 3 });
    expect((await rowOf(s, s.staff.huda, nextMonth())).base_minor).toBe(Math.round((250000 * 15) / dimNext));
    const ongoing = (await s.owner.call(entries.GET, { params: p, query: { month: nextMonth() } })).body.data;
    expect(ongoing.find((e: any) => e.id === adv.body.data.id)).toMatchObject({ installments: 3, settled_parts: 1 });
    // Entries cannot be dated before the latest closed month.
    expect((await add({ kind: 'bonus', amount_minor: 7000, effective_on: now().minus({ months: 1 }).startOf('month').toISODate() })).body.error.code).toBe('payroll_period_closed');

    // Pay from the bank, once.
    const paid = await s.owner.call(pay.POST, { params: { ...p, id: saraSlip.id }, body: { method: 'bank_transfer', reference: 'TRX-1' } });
    expect(paid.status).toBe(200);
    expect((await s.owner.call(pay.POST, { params: { ...p, id: saraSlip.id }, body: {} })).body.error.code).toBe('payslip_already_paid');
    const payLines = await withTenant(s.tenantId, (trx) => trx.selectFrom('financial_entries').select(['account', 'credit_minor']).where('ref_type', '=', 'payroll_payment').execute());
    expect(payLines.find((l) => l.account === 'bank')!.credit_minor).toBe(saraSlip.net_minor);
    const html = String((await s.owner.call(slip.GET, { params: { ...p, id: saraSlip.id } })).body);
    expect(html).toContain(saraSlip.number);

    const r = (await s.owner.call(report.GET, { params: p, query: { from: `${thisMonth()}-01`, to: futureDate(0) } })).body.data;
    expect(r.salaries.amount_minor).toBe(sara.base_minor + 250000 + 10000 - 2000);
  });

  it('lets staff see only their own earnings and payslips, and limits who can manage payroll', async () => {
    const s = await makeSalon();
    const p = { tenantSlug: s.slug };
    await s.owner.call(salary.PUT, { method: 'PUT', params: { ...p, staffId: s.staff.sara }, body: { base_salary_minor: 200000 } });
    await s.owner.call(salary.PUT, { method: 'PUT', params: { ...p, staffId: s.staff.huda }, body: { base_salary_minor: 180000 } });
    const saraUser = await member(s, 'specialist', s.staff.sara);
    const reception = await member(s, 'receptionist');
    const fin = await member(s, 'finance');

    const mine = await saraUser.call(earnings.GET, { params: p, query: { month: thisMonth() } });
    expect(mine.status).toBe(200);
    expect(mine.body.data).toMatchObject({ status: 'open', current: { staff_id: s.staff.sara, base_minor: 200000, net_minor: 200000 } });
    expect((await saraUser.call(sheet.GET, { params: p, query: { month: thisMonth() } })).status).toBe(403);
    expect((await saraUser.call(entries.POST, { params: p, body: { staff_id: s.staff.sara, kind: 'bonus', amount_minor: 1000 } })).status).toBe(403);
    expect((await reception.call(entries.POST, { params: p, body: { staff_id: s.staff.sara, kind: 'bonus', amount_minor: 1000 } })).status).toBe(403);
    expect((await reception.call(policy.PATCH, { method: 'PATCH', params: p, body: { products: { enabled: true, rate_bp: 5000, tiers: [] } } })).status).toBe(403);
    expect((await fin.call(sheet.GET, { params: p, query: { month: thisMonth() } })).status).toBe(200);
    expect((await fin.call(close.POST, { params: p, body: { month: thisMonth() } })).status).toBe(201);

    const rows = (await s.owner.call(sheet.GET, { params: p, query: { month: thisMonth() } })).body.data.rows;
    const own = rows.find((r: any) => r.staff_id === s.staff.sara);
    const other = rows.find((r: any) => r.staff_id === s.staff.huda);
    expect((await saraUser.call(slip.GET, { params: { ...p, id: own.id } })).status).toBe(200);
    expect((await saraUser.call(slip.GET, { params: { ...p, id: other.id } })).status).toBe(404);
    const after = (await saraUser.call(earnings.GET, { params: p, query: { month: thisMonth() } })).body.data;
    expect(after.status).toBe('closed');
    expect(after.slips).toHaveLength(1);
    expect(after.slips[0]).toMatchObject({ id: own.id, net_minor: 200000, month: thisMonth() });

    await s.owner.call(policy.PATCH, { method: 'PATCH', params: p, body: { tips_enabled: false } });
    expect((await s.owner.call(entries.POST, { params: p, body: { staff_id: s.staff.sara, kind: 'tip', amount_minor: 1000, method: 'cash' } })).body.error.code).toBe('tips_disabled');
  });
});
