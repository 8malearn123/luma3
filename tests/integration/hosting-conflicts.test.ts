import { describe, expect, it } from 'vitest';
import { at, customer, futureDate, makeSalon } from '../helpers/salon';
import { createBusinessFor, signup } from '../helpers/factory';
import { withSystem, withTenant } from '@/server/db/client';
import * as resourceTypes from '@/app/api/v1/t/[tenantSlug]/resource-types/route';
import * as resources from '@/app/api/v1/t/[tenantSlug]/resources/route';
import * as services from '@/app/api/v1/t/[tenantSlug]/services/route';
import * as schedule from '@/app/api/v1/t/[tenantSlug]/staff/[id]/schedule/route';
import * as accounts from '@/app/api/v1/t/[tenantSlug]/payment-accounts/route';
import * as reauth from '@/app/api/v1/auth/reauth/route';
import * as hold from '@/app/api/v1/s/[slug]/bookings/route';
import * as links from '@/app/api/v1/t/[tenantSlug]/hosting/links/route';
import * as listings from '@/app/api/v1/t/[tenantSlug]/hosting/listings/route';
import * as listingStatus from '@/app/api/v1/t/[tenantSlug]/hosting/listings/[id]/status/route';
import * as wsBookings from '@/app/api/v1/t/[tenantSlug]/workspace/bookings/route';
import * as groupSessions from '@/app/api/v1/t/[tenantSlug]/group-sessions/route';

/**
 * Verification gap (audit §2, LUMA-AUDIT-046): workspace resources against the
 * other reservation types, under PARALLEL transactions — internal bookings of a
 * linked specialist, shared equipment, and group sessions / event bookings of a
 * specialist linked to the rented chair (which reserve the specialist, not the chair).
 */
const WEEK = Array.from({ length: 7 }, (_, d) => ({ weekday: d, start_time: '08:00', end_time: '22:00' }));
const iso = (s: string) => new Date(s).toISOString();

async function host() {
  const s = await makeSalon();
  const p = { tenantSlug: s.slug };
  const type = await s.owner.call(resourceTypes.POST, { params: p, body: { name_en: 'Chair' } });
  const mk = async (name: string) => (await s.owner.call(resources.POST, { params: p, body: { branch_id: s.branchId, resource_type_id: type.body.data.id, name } })).body.data.id as string;
  const chair1 = await mk('Chair 1'), chair2 = await mk('Chair 2'), dryer = await mk('Dryer');
  const list = async (chair: string, code: string) => {
    const l = await s.owner.call(listings.POST, { params: p, body: {
      branch_id: s.branchId, resource_id: chair, code, price_model: 'fixed_hour', price_minor: 5000, booking_mode: 'instant', windows: WEEK,
      addons: [{ kind: 'equipment', resource_id: dryer, name_en: 'Dryer', rental_price_minor: 1000, rental_unit: 'booking' }],
    } });
    expect(l.status, JSON.stringify(l.body)).toBe(201);
    const pub = await s.owner.call(listingStatus.POST, { params: { ...p, id: l.body.data.id }, body: { status: 'published', version: l.body.data.version } });
    expect(pub.status).toBe(200);
    return pub.body.data as { id: string; addons: Array<{ id: string }> };
  };
  const l1 = await list(chair1, 'C-1');
  const l2 = await list(chair2, 'C-2');
  expect((await s.owner.call(links.PUT, { params: p, body: { resource_id: chair1, staff_ids: [s.staff.huda] } })).status).toBe(200);
  return { ...s, chair1, chair2, dryer, l1, l2 };
}

async function expert(name = 'Expert') {
  const owner = await signup(name);
  const biz = await createBusinessFor(owner, { business_type: 'expert', plan_code: 'sanaa' });
  const p = { tenantSlug: biz.slug };
  await owner.call(schedule.PUT, { params: { ...p, id: biz.staffProfileId! }, body: { branch_id: biz.branchId, ranges: Array.from({ length: 7 }, (_, d) => ({ weekday: d, start_time: '08:00', end_time: '23:00' })), breaks: [] } });
  await owner.call(reauth.POST, { body: { password: 'correct horse battery' } });
  await owner.call(accounts.POST, { params: p, body: { provider: 'sandbox' } });
  await withSystem('test: activate expert', (trx) => trx.updateTable('tenants').set({ status: 'active' }).where('id', '=', biz.tenantId).execute());
  return { owner, slug: biz.slug };
}

const requestSpace = (x: Awaited<ReturnType<typeof expert>>, listingId: string, start: string, addons: Array<{ addon_id: string; quantity: number }> = []) =>
  x.owner.call(wsBookings.POST, { params: { tenantSlug: x.slug }, body: { listing_id: listingId, start: iso(start), duration_min: 60, addons }, idempotencyKey: true });

describe('workspace conflicts under concurrency', () => {
  it('internal booking of the linked specialist vs a space request on her chair: exactly one wins (resource exclusion)', async () => {
    const h = await host();
    const x = await expert();
    for (const [i, hhmm] of ['10:00', '12:00', '14:00', '16:00'].entries()) {
      const d = futureDate(4 + i);
      const c = await customer();
      const [internal, space] = await Promise.all([
        c.call(hold.POST, { params: { slug: h.slug }, body: { items: [{ key: 'a', service_id: h.services.nails, staff_id: h.staff.huda, start: iso(at(d, hhmm)) }] }, idempotencyKey: true }),
        requestSpace(x, h.l1.id, at(d, hhmm)),
      ]);
      expect([internal.status, space.status].filter((s) => s === 201), `${internal.status}/${space.status}`).toHaveLength(1);
    }
  });

  it('shared equipment: two space requests on different chairs with the same device at the same time — exactly one wins', async () => {
    const h = await host();
    const [a, b] = [await expert('A'), await expert('B')];
    const d = futureDate(9);
    const [r1, r2] = await Promise.all([
      requestSpace(a, h.l1.id, at(d, '11:00'), [{ addon_id: h.l1.addons[0]!.id, quantity: 1 }]),
      requestSpace(b, h.l2.id, at(d, '11:00'), [{ addon_id: h.l2.addons[0]!.id, quantity: 1 }]),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([201, 409]);
  });

  it('group session of the linked specialist vs a space request on her chair: a parallel race cannot double-book (DB guarantee)', async () => {
    const h = await host();
    const x = await expert();
    const svc = await h.owner.call(services.POST, { params: { tenantSlug: h.slug }, body: { name_ar: 'ورشة', price_minor: 20000, duration_min: 60, booking_mode: 'group', staff: [{ staff_id: h.staff.huda }] } });
    expect(svc.status).toBe(201);
    const d = futureDate(12);
    // A group session for Huda is being created (transaction open, not committed) while the expert
    // requests Huda's chair for the same hour. The space request's availability check cannot see
    // the uncommitted session; only the database can serialise the two.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let inserted!: () => void;
    const insertedP = new Promise<void>((r) => { inserted = r; });
    const groupTx = withTenant(h.tenantId, async (trx) => {
      const g = await trx.insertInto('group_sessions').values({ tenant_id: h.tenantId, branch_id: h.branchId, service_id: svc.body.data.id, staff_id: h.staff.huda, starts_at: new Date(at(d, '10:00')), ends_at: new Date(at(d, '11:00')), capacity: 5, price_minor: 20000 })
        .returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('booking_allocations').values({ tenant_id: h.tenantId, group_session_id: g.id, staff_id: h.staff.huda, during: `[${iso(at(d, '10:00'))},${iso(at(d, '11:00'))})`, state: 'confirmed' }).execute();
      inserted();
      await gate;
      return g.id;
    });
    await insertedP;
    const spaceP = requestSpace(x, h.l1.id, at(d, '10:00'));
    const first = await Promise.race([spaceP.then(() => 'space'), new Promise((r) => setTimeout(() => r('waiting'), 700))]);
    release();
    await groupTx;
    const space = await spaceP;
    // Without a DB guarantee the space request returns 201 at once and both reservations stand.
    expect(first).toBe('waiting');
    expect(space.status).toBe(409);
    expect(space.body.error.code).toBe('slot_unavailable');
  });

  it('group session created after the chair is rented to an expert is refused for the linked specialist', async () => {
    const h = await host();
    const x = await expert();
    const d = futureDate(14);
    expect((await requestSpace(x, h.l1.id, at(d, '15:00'))).status).toBe(201);
    const svc = await h.owner.call(services.POST, { params: { tenantSlug: h.slug }, body: { name_ar: 'ورشة', price_minor: 20000, duration_min: 60, booking_mode: 'group', staff: [{ staff_id: h.staff.huda, }, { staff_id: h.staff.sara }] } });
    const g = await h.owner.call(groupSessions.POST, { params: { tenantSlug: h.slug }, body: { branch_id: h.branchId, service_id: svc.body.data.id, staff_id: h.staff.huda, starts_at: iso(at(d, '15:30')), capacity: 4 } });
    expect(g.status).toBe(409);
    expect(g.body.error.code).toBe('slot_unavailable');
    // A specialist not linked to the rented chair is unaffected.
    const ok = await h.owner.call(groupSessions.POST, { params: { tenantSlug: h.slug }, body: { branch_id: h.branchId, service_id: svc.body.data.id, staff_id: h.staff.sara, starts_at: iso(at(d, '15:30')), capacity: 4 } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    // And once the space request is gone (expired/cancelled), Huda can run the session.
    await withSystem('test: release the space hold', (trx) => trx.updateTable('booking_allocations').set({ state: 'released', released_at: new Date() }).where('workspace_booking_id', 'is not', null).where('resource_id', '=', h.chair1).execute());
    expect((await h.owner.call(groupSessions.POST, { params: { tenantSlug: h.slug }, body: { branch_id: h.branchId, service_id: svc.body.data.id, staff_id: h.staff.huda, starts_at: iso(at(d, '15:30')), capacity: 4 } })).status).toBe(201);
  });
});
