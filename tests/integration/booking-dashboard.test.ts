import { describe, expect, it } from 'vitest';
import { at, futureDate, makeSalon, type Salon } from '../helpers/salon';
import { signup } from '../helpers/factory';
import * as customers from '@/app/api/v1/t/[tenantSlug]/customers/route';
import * as tBookings from '@/app/api/v1/t/[tenantSlug]/bookings/route';
import * as tBooking from '@/app/api/v1/t/[tenantSlug]/bookings/[id]/route';
import * as invitations from '@/app/api/v1/t/[tenantSlug]/invitations/route';
import * as accept from '@/app/api/v1/invitations/accept/route';
import * as onSite from '@/app/api/v1/t/[tenantSlug]/payments/on-site/route';
import * as meProfile from '@/app/api/v1/t/[tenantSlug]/me/profile/route';

/** Signs up a user and links her to `staffId` as a specialist of the salon. */
async function specialistFor(s: Salon, staffId: string) {
  const u = await signup('Specialist');
  const inv = await s.owner.call(invitations.POST, { params: { tenantSlug: s.slug }, body: { identifier: u.identifier, role: 'specialist', staff_profile_id: staffId } });
  expect(inv.status).toBe(201);
  const ok = await u.call(accept.POST, { body: { token: inv.body.data.dev_invite_link.split('/invite/')[1] } });
  expect(ok.status).toBe(200);
  return u;
}

async function receptionBooking(s: Salon) {
  const c = await s.owner.call(customers.POST, { params: { tenantSlug: s.slug }, body: { display_name: 'Walk-in Reem', phone: '0551234567' } });
  expect(c.status).toBe(201);
  const d = futureDate(8);
  const r = await s.owner.call(tBookings.POST, {
    params: { tenantSlug: s.slug }, idempotencyKey: true,
    body: { customer_id: c.body.data.id, mode: 'confirm_on_site', items: [{ key: 'a', service_id: s.services.haircut, staff_id: s.staff.sara, start: at(d, '11:00') }, { key: 'b', service_id: s.services.nails, staff_id: s.staff.huda, start: at(d, '12:00') }] },
  });
  expect(r.status).toBe(201);
  expect(r.body.data.confirmed).toBe(true);
  return { id: r.body.data.booking_id as string, date: d };
}

describe('dashboard bookings API', () => {
  it('lists per-specialist segments and filters by branch', async () => {
    const s = await makeSalon();
    const { id, date } = await receptionBooking(s);
    const list = await s.owner.call(tBookings.GET, { params: { tenantSlug: s.slug }, query: { from: at(date, '00:00'), to: at(date, '23:59'), branch_id: s.branchId } });
    expect(list.status).toBe(200);
    const row = list.body.data.find((b: any) => b.id === id);
    expect(row.branch_id).toBe(s.branchId);
    expect(row.total_minor).toBe(18000);
    expect(row.segments.map((x: any) => [x.staff_id, new Date(x.starts_at).toISOString()])).toEqual([
      [s.staff.sara, new Date(at(date, '11:00')).toISOString()],
      [s.staff.huda, new Date(at(date, '12:00')).toISOString()],
    ]);
    const other = await s.owner.call(tBookings.GET, { params: { tenantSlug: s.slug }, query: { branch_id: '00000000-0000-4000-8000-000000000000' } });
    expect(other.body.data).toEqual([]);
  });

  it('assigned specialists see their bookings without any financial fields', async () => {
    const s = await makeSalon();
    const { id } = await receptionBooking(s);
    const pay = await s.owner.call(onSite.POST, { params: { tenantSlug: s.slug }, idempotencyKey: true, body: { booking_id: id, amount_minor: 5000, method: 'cash', reference: 'R-1' } });
    expect(pay.status).toBe(201);
    const owner = await s.owner.call(tBooking.GET, { params: { tenantSlug: s.slug, id } });
    expect(owner.body.data.paid_minor).toBe(5000);
    expect(owner.body.data.payments[0].refunded_or_pending_minor).toBe(0);

    const sara = await specialistFor(s, s.staff.sara);
    const list = await sara.call(tBookings.GET, { params: { tenantSlug: s.slug } });
    expect(list.status).toBe(200);
    const row = list.body.data.find((b: any) => b.id === id);
    expect(row).toBeTruthy();
    for (const k of ['total_minor', 'paid_minor', 'payment_status']) expect(row).not.toHaveProperty(k);
    const detail = await sara.call(tBooking.GET, { params: { tenantSlug: s.slug, id } });
    expect(detail.status).toBe(200);
    const b = detail.body.data;
    for (const k of ['total_minor', 'paid_minor', 'subtotal_minor', 'tax_minor', 'refunded_minor', 'payment_status', 'payment_terms']) expect(b).not.toHaveProperty(k);
    expect(b.items).toHaveLength(2);
    for (const i of b.items) for (const k of ['unit_price_minor', 'line_total_minor', 'addons_price_minor']) expect(i).not.toHaveProperty(k);
    expect(b.payments).toEqual([]);
    expect(JSON.stringify(b.events)).not.toMatch(/total_minor/);
  });

  it('me/profile returns the linked staff profile and 404 when not linked', async () => {
    const s = await makeSalon();
    const sara = await specialistFor(s, s.staff.sara);
    const r = await sara.call(meProfile.GET, { params: { tenantSlug: s.slug } });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ id: s.staff.sara, display_name: 'Sara' });
    const patch = await sara.call(meProfile.PATCH, { method: 'PATCH', params: { tenantSlug: s.slug }, body: { bio_ar: 'خبيرة صبغات' } });
    expect(patch.status).toBe(200);
    expect((await sara.call(meProfile.GET, { params: { tenantSlug: s.slug } })).body.data.bio_ar).toBe('خبيرة صبغات');
    // The owner of a fresh salon is not linked to a staff profile.
    expect((await s.owner.call(meProfile.GET, { params: { tenantSlug: s.slug } })).status).toBe(404);
  });
});
