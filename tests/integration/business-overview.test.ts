import { describe, expect, it } from 'vitest';
import { withTenant } from '@/server/db/client';
import { createBusinessFor, signup } from '../helpers/factory';
import { addMember } from '../helpers/commerce';
import { booking, customer, service, staffWithHours, todayAt, userIdOf } from '../helpers/business';
import * as overview from '@/app/api/v1/t/[tenantSlug]/overview/route';

async function setup() {
  const owner = await signup('ريم المالكة');
  const biz = await createBusinessFor(owner, { plan_code: 'wahaj' });
  const p = { tenantSlug: biz.slug };
  const reception = await addMember(owner, biz.slug, 'receptionist');
  const specialist = await addMember(owner, biz.slug, 'specialist');
  const finance = await addMember(owner, biz.slug, 'finance');
  const a = await staffWithHours(biz, 'سارة');
  const b = await staffWithHours(biz, 'هدى', biz.branchId, { userId: await userIdOf(specialist) });
  const svc = await service(biz);
  const cus = await customer(biz);
  // Today: A 10000 (paid), B 20000, one cancelled (excluded); tomorrow: B upcoming.
  await booking(biz, { customerId: cus, serviceId: svc, staffId: a, startsAt: todayAt('00:30'), price: 10000, status: 'completed', capture: true, collectedBy: await userIdOf(owner) });
  await booking(biz, { customerId: cus, serviceId: svc, staffId: b, startsAt: todayAt('01:30'), price: 20000, status: 'confirmed' });
  await booking(biz, { customerId: cus, serviceId: svc, staffId: a, startsAt: todayAt('02:30'), price: 99000, status: 'cancelled' });
  const upcoming = await booking(biz, { customerId: cus, serviceId: svc, staffId: b, startsAt: todayAt('12:00', 1), price: 15000 });
  const bk = await booking(biz, { customerId: cus, serviceId: svc, staffId: a, startsAt: todayAt('00:10', -2), status: 'completed' });
  await withTenant(biz.tenantId, (trx) => trx.insertInto('reviews').values({ tenant_id: biz.tenantId, booking_id: bk, tenant_customer_id: cus, rating: 5, comment: 'رائعة', staff_id: a }).execute());
  return { owner, reception, specialist, finance, biz, p, staff: { a, b }, upcoming };
}

describe('business overview', () => {
  it('owner sees KPIs, money, team, charts, next appointments, reviews and plan usage', async () => {
    const s = await setup();
    const r = await s.owner.call(overview.GET, { params: s.p });
    expect(r.status).toBe(200);
    const d = r.body.data;
    expect(d.variant).toBe('business');
    expect(d.kpis.bookings_today).toBe(2); // completed + confirmed; cancelled excluded
    expect(d.kpis.bookings_by_status).toMatchObject({ completed: 1, confirmed: 1 });
    expect(d.kpis.bookings_by_status.cancelled).toBeUndefined();
    expect(d.kpis.expected_revenue_today_minor).toBe(30000);
    expect(d.kpis.staff_on_duty.on_duty).toBeGreaterThanOrEqual(2);
    expect(typeof d.kpis.occupancy_today).toBe('number');
    expect(d.series).toHaveLength(7);
    expect(d.series[6].bookings).toBe(2);
    expect(d.series[6].sales_minor).toBe(10000);
    expect(d.next_appointments.map((x: any) => x.id)).toContain(s.upcoming);
    expect(d.next_appointments[d.next_appointments.length - 1].total_minor).toBeTypeOf('number');
    expect(d.staff_today.map((x: any) => x.staff_id)).toEqual(expect.arrayContaining([s.staff.a, s.staff.b]));
    expect(d.latest_reviews.items[0]).toMatchObject({ rating: 5, customer_name: 'نورة' });
    expect(d.plan_usage.items.find((i: any) => i.key === 'limit.staff')).toMatchObject({ limit: 12 });
    expect(d.store.path).toBe(`/s/${s.biz.slug}`);
  });

  it('hides money from a receptionist and limits a specialist to her own bookings', async () => {
    const s = await setup();
    const rec = (await s.reception.call(overview.GET, { params: s.p })).body.data;
    expect(rec.kpis.bookings_today).toBe(2);
    expect(rec.kpis.expected_revenue_today_minor).toBeNull();
    expect(rec.series[6]).not.toHaveProperty('sales_minor');
    expect(rec.next_appointments.every((x: any) => !('total_minor' in x))).toBe(true);
    expect(rec.plan_usage).toBeNull();
    expect(rec.latest_reviews).not.toBeNull(); // customers.view

    const sp = (await s.specialist.call(overview.GET, { params: s.p })).body.data;
    expect(sp.kpis.bookings_today).toBe(1); // only Huda's booking
    expect(sp.kpis.expected_revenue_today_minor).toBeNull();
    expect(sp.next_appointments.map((x: any) => x.id)).toContain(s.upcoming);
    expect(sp.next_appointments.length).toBeLessThanOrEqual(2); // never Sara's bookings
    expect(sp.staff_today).toBeNull();
    expect(sp.latest_reviews).toBeNull();
    expect(sp.kpis.staff_on_duty).toBeNull();
    expect(sp.perms).toMatchObject({ money: false, allBookings: false, ownBookings: true });

    const fin = (await s.finance.call(overview.GET, { params: s.p })).body.data;
    expect(fin.perms.money).toBe(true);
    expect(fin.kpis.bookings_today).toBeNull();
    expect(fin.next_appointments).toBeNull();
  });

  it('independent experts get the personal variant: my day, earnings, profile completion', async () => {
    const owner = await signup('لمى');
    const biz = await createBusinessFor(owner, { business_type: 'expert', plan_code: 'sanaa' });
    const me = biz.staffProfileId ?? await staffWithHours(biz, 'لمى', biz.branchId, { userId: await userIdOf(owner) });
    const svc = await service(biz);
    const cus = await customer(biz);
    await booking(biz, { customerId: cus, serviceId: svc, staffId: me, startsAt: todayAt('00:20'), price: 25000, status: 'completed' });
    const r = await owner.call(overview.GET, { params: { tenantSlug: biz.slug } });
    expect(r.status).toBe(200);
    const d = r.body.data;
    expect(d.variant).toBe('expert');
    expect(d.greeting_name).toBe('لمى');
    expect(d.today.bookings).toBe(1);
    expect(d.my_appointments_today).toHaveLength(1);
    expect(d.earnings_month.amount_minor).toBe(25000);
    expect(d.profile_completion.percent).toBeGreaterThan(0);
    expect(d.profile_completion.percent).toBeLessThan(100);
    expect(d.profile_completion.items.find((i: any) => i.key === 'services').ok).toBe(true);
  });
});
