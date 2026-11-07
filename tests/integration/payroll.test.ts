import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { at, customer, futureDate, makeSalon, TZ, type Salon } from '../helpers/salon';
import { signup } from '../helpers/factory';
import { withTenant } from '@/server/db/client';
import * as hold from '@/app/api/v1/s/[slug]/bookings/route';
import * as checkout from '@/app/api/v1/s/[slug]/bookings/[id]/checkout/route';
import * as onSite from '@/app/api/v1/t/[tenantSlug]/payments/on-site/route';
import * as report from '@/app/api/v1/t/[tenantSlug]/finance/report/route';
import * as rules from '@/app/api/v1/t/[tenantSlug]/finance/commission-rules/route';
import * as invitations from '@/app/api/v1/t/[tenantSlug]/invitations/route';
import * as accept from '@/app/api/v1/invitations/accept/route';
import * as policy from '@/app/api/v1/t/[tenantSlug]/payroll/commission-policy/route';
import * as serviceCommission from '@/app/api/v1/t/[tenantSlug]/payroll/commission-policy/services/[serviceId]/route';
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

const thisMonth = () => DateTime.now().setZone(TZ).toFormat('yyyy-MM');
const nextMonth = () => DateTime.now().setZone(TZ).plus({ months: 1 }).toFormat('yyyy-MM');
const today = () => DateTime.now().setZone(TZ).toISODate()!;

/** Books a service on site, takes payment and completes it, so commission is earned now. */
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
  const now = new Date(b.starts_at.getTime() + 60_000);
  await transition(s.tenantId, id, 'check_in', actor, { now });
  await transition(s.tenantId, id, 'complete', actor, { now });
  return id;
}

async function commissionsFor(s: Salon, bookingId: string) {
  return withTenant(s.tenantId, (trx) => trx.selectFrom('commission_entries as e').innerJoin('booking_items as i', 'i.id', 'e.booking_item_id')
    .select(['e.amount_minor', 'e.base_minor', 'e.staff_id']).where('i.booking_id', '=', bookingId).execute());
}

async function member(s: Salon, role: 'specialist' | 'receptionist' | 'finance', staffProfileId?: string) {
  const m = await signup(role);
  const inv = await s.owner.call(invitations.POST, { params: { tenantSlug: s.slug }, body: { identifier: m.identifier, role, ...(staffProfileId ? { staff_profile_id: staffProfileId } : {}) } });
  expect(inv.status).toBe(201);
  const token = inv.body.data.dev_invite_link.split('/invite/')[1];
  expect((await m.call(accept.POST, { body: { token } })).status).toBe(200);
  return m;
}

describe('service commission policy (decided by the business)', () => {
  it('applies the per-service rate, honours a switched-off service over any other rule, and stops entirely when switched off', async () => {
    const s = await makeSalon();
    const p = { tenantSlug: s.slug };
    // Default 10% for every service, haircut 20%, colour switched off.
    expect((await s.owner.call(policy.PATCH, { method: 'PATCH', params: p, body: { default_rate_bp: 1000 } })).status).toBe(200);
    expect((await s.owner.call(serviceCommission.PUT, { method: 'PUT', params: { ...p, serviceId: s.services.haircut }, body: { commission_enabled: true, rate_bp: 2000 } })).status).toBe(200);
    expect((await s.owner.call(serviceCommission.PUT, { method: 'PUT', params: { ...p, serviceId: s.services.color }, body: { commission_enabled: false, rate_bp: null } })).status).toBe(200);
    const pol = (await s.owner.call(policy.GET, { params: p })).body.data;
    expect(pol).toMatchObject({ service_commission_enabled: true, products_earn_commission: false, default_rule: { kind: 'percent', rate_bp: 1000 } });
    expect(pol.services.find((x: any) => x.id === s.services.haircut)).toMatchObject({ commission_enabled: true, rule: { rate_bp: 2000 } });
    expect(pol.services.find((x: any) => x.id === s.services.color)).toMatchObject({ commission_enabled: false, rule: null });

    // Haircut earns 20% of its net.
    const cut = await commissionsFor(s, await serve(s, s.services.haircut, s.staff.sara, 2));
    expect(cut).toHaveLength(1);
    expect(cut[0]!.amount_minor).toBe(Math.round(cut[0]!.base_minor * 0.2));
    // Nails has no own rate: the 10% default applies.
    const nails = await commissionsFor(s, await serve(s, s.services.nails, s.staff.huda, 2, '12:00'));
    expect(nails[0]!.amount_minor).toBe(Math.round(nails[0]!.base_minor * 0.1));
    // A staff rule for Sara does not override a switched-off service.
    expect((await s.owner.call(rules.POST, { params: p, body: { kind: 'percent', rate_bp: 5000, staff_id: s.staff.sara } })).status).toBe(201);
    expect(await commissionsFor(s, await serve(s, s.services.color, s.staff.sara, 3))).toHaveLength(0);

    // Changing a rate deactivates the old rule (history kept), never edits it.
    await s.owner.call(serviceCommission.PUT, { method: 'PUT', params: { ...p, serviceId: s.services.haircut }, body: { commission_enabled: true, rate_bp: 1500 } });
    const haircutRules = await withTenant(s.tenantId, (trx) => trx.selectFrom('commission_rules').select(['rate_bp', 'is_active']).where('service_id', '=', s.services.haircut).where('staff_id', 'is', null).execute());
    expect(haircutRules.map((r) => [r.rate_bp, r.is_active]).sort()).toEqual([[1500, true], [2000, false]]);

    // Business switch off: nothing is earned on any service.
    expect((await s.owner.call(policy.PATCH, { method: 'PATCH', params: p, body: { service_commission_enabled: false } })).body.data.service_commission_enabled).toBe(false);
    expect(await commissionsFor(s, await serve(s, s.services.haircut, s.staff.huda, 4))).toHaveLength(0);
  });
});

describe('payroll', () => {
  it('computes net pay, closes the month once with frozen payslips, carries later items forward and posts a balanced journal', async () => {
    const s = await makeSalon();
    const p = { tenantSlug: s.slug };
    await s.owner.call(policy.PATCH, { method: 'PATCH', params: p, body: { default_rate_bp: 1000 } });
    expect((await s.owner.call(salary.PUT, { method: 'PUT', params: { ...p, staffId: s.staff.sara }, body: { base_salary_minor: 300000 } })).status).toBe(200);
    expect((await s.owner.call(salary.PUT, { method: 'PUT', params: { ...p, staffId: s.staff.huda }, body: { base_salary_minor: 250000 } })).status).toBe(200);
    expect((await s.owner.call(salaries.GET, { params: p })).body.data.find((x: any) => x.staff_id === s.staff.sara).base_salary_minor).toBe(300000);

    const booking = await serve(s, s.services.haircut, s.staff.sara, 2);
    const [c] = await commissionsFor(s, booking);
    // Tip: only for someone who served the booking.
    expect((await s.owner.call(tips.POST, { params: p, body: { booking_id: booking, staff_id: s.staff.huda, amount_minor: 5000, method: 'cash' } })).body.error.code).toBe('tip_staff_not_on_booking');
    expect((await s.owner.call(tips.POST, { params: p, body: { booking_id: booking, staff_id: s.staff.sara, amount_minor: 5000, method: 'cash' } })).status).toBe(201);
    const add = (kind: string, amount: number, staffId = s.staff.sara, effective_on = today()) => s.owner.call(entries.POST, { params: p, body: { staff_id: staffId, kind, amount_minor: amount, effective_on } });
    expect((await add('bonus', 10000)).status).toBe(201);
    expect((await add('deduction', 2000)).status).toBe(201);
    const adv = await add('advance', 50000);
    expect(adv.status).toBe(201);
    const mistake = await add('bonus', 99900);
    expect((await s.owner.call(voidEntry.POST, { params: { ...p, id: mistake.body.data.id }, body: { reason: 'wrong person' } })).status).toBe(200);

    const draft = (await s.owner.call(sheet.GET, { params: p, query: { month: thisMonth() } })).body.data;
    expect(draft.status).toBe('open');
    expect(draft.close.allowed).toBe(true);
    const sara = draft.rows.find((r: any) => r.staff_id === s.staff.sara);
    expect(sara).toMatchObject({ base_minor: 300000, commission_minor: c!.amount_minor, commission_count: 1, tips_minor: 5000, bonus_minor: 10000, deduction_minor: 2000, advance_minor: 50000 });
    expect(sara.net_minor).toBe(300000 + c!.amount_minor + 5000 + 10000 - 2000 - 50000);
    expect(sara).not.toHaveProperty('commission_ids');
    expect(draft.rows.find((r: any) => r.staff_id === s.staff.huda).net_minor).toBe(250000);

    // Close the month: one payslip per staff member, once.
    const closed = await s.owner.call(close.POST, { params: p, body: { month: thisMonth() } });
    expect(closed.status).toBe(201);
    expect((await s.owner.call(close.POST, { params: p, body: { month: thisMonth() } })).body.error.code).toBe('payroll_already_closed');
    const frozen = (await s.owner.call(sheet.GET, { params: p, query: { month: thisMonth() } })).body.data;
    expect(frozen.status).toBe('closed');
    expect(frozen.totals.net_minor).toBe(sara.net_minor + 250000);
    const saraSlip = frozen.rows.find((r: any) => r.staff_id === s.staff.sara);
    expect(saraSlip.number).toMatch(/^PAY-\d{6}$/);
    expect(saraSlip.net_minor).toBe(sara.net_minor);

    // Payroll journal is balanced and uses the payroll accounts.
    const lines = await withTenant(s.tenantId, (trx) => trx.selectFrom('financial_entries').select(['account', 'debit_minor', 'credit_minor']).where('ref_type', '=', 'payroll_close').execute());
    expect(lines.reduce((a, l) => a + l.debit_minor - l.credit_minor, 0)).toBe(0);
    expect(lines.find((l) => l.account === 'payroll_payable')!.credit_minor).toBe(frozen.totals.net_minor);
    expect(lines.find((l) => l.account === 'salaries_expense')!.debit_minor).toBe(300000 + 250000 + 10000 - 2000);

    // Settled entries cannot be voided; items after the close carry to next month.
    expect((await s.owner.call(voidEntry.POST, { params: { ...p, id: adv.body.data.id }, body: { reason: 'try to undo' } })).body.error.code).toBe('payroll_entry_settled');
    expect((await add('bonus', 7000)).status).toBe(201);
    const before = DateTime.now().setZone(TZ).minus({ months: 1 }).startOf('month').toISODate()!;
    expect((await add('bonus', 7000, s.staff.sara, before)).body.error.code).toBe('payroll_period_closed');
    const next = (await s.owner.call(sheet.GET, { params: p, query: { month: nextMonth() } })).body.data;
    expect(next.carried_from).toBe(thisMonth());
    expect(next.rows.find((r: any) => r.staff_id === s.staff.sara)).toMatchObject({ bonus_minor: 7000, commission_minor: 0, tips_minor: 0, net_minor: 300000 + 7000 });
    expect(next.close).toMatchObject({ allowed: false, blocker: 'payroll_month_in_future' });

    // Pay a payslip once.
    expect((await s.owner.call(pay.POST, { params: { ...p, id: saraSlip.id }, body: { reference: 'TRX-1' } })).status).toBe(200);
    expect((await s.owner.call(pay.POST, { params: { ...p, id: saraSlip.id }, body: {} })).body.error.code).toBe('payslip_already_paid');
    const html = await s.owner.call(slip.GET, { params: { ...p, id: saraSlip.id } });
    expect(html.status).toBe(200);
    expect(String(html.body)).toContain(saraSlip.number);

    // The finance report includes salaries in the profit formula.
    const r = (await s.owner.call(report.GET, { params: p, query: { from: `${thisMonth()}-01`, to: futureDate(0) } })).body.data;
    expect(r.salaries.amount_minor).toBe(300000 + 250000 + 10000 - 2000);
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
    // Reception can record tips at the counter but not bonuses.
    expect((await reception.call(entries.POST, { params: p, body: { staff_id: s.staff.sara, kind: 'bonus', amount_minor: 1000 } })).status).toBe(403);
    // The finance role can run payroll.
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

    // Tips can be switched off by the business.
    await s.owner.call(policy.PATCH, { method: 'PATCH', params: p, body: { tips_enabled: false } });
    expect((await s.owner.call(entries.POST, { params: p, body: { staff_id: s.staff.sara, kind: 'tip', amount_minor: 1000, method: 'cash' } })).body.error.code).toBe('tips_disabled');
  });
});
