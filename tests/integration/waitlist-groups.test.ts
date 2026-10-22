import { describe, expect, it } from 'vitest';
import { at, customer, futureDate, makeSalon } from '../helpers/salon';
import { withTenant } from '@/server/db/client';
import * as hold from '@/app/api/v1/s/[slug]/bookings/route';
import * as checkout from '@/app/api/v1/s/[slug]/bookings/[id]/checkout/route';
import * as join from '@/app/api/v1/s/[slug]/waitlist/route';
import * as accept from '@/app/api/v1/account/waitlist/offers/[id]/accept/route';
import * as accountCancel from '@/app/api/v1/account/bookings/[id]/cancel/route';
import * as services from '@/app/api/v1/t/[tenantSlug]/services/route';
import * as groups from '@/app/api/v1/t/[tenantSlug]/group-sessions/route';
import * as bookGroup from '@/app/api/v1/s/[slug]/group-sessions/[id]/book/route';

describe('waitlist', () => {
  it('offers a freed slot to one consenting customer at a time; acceptance needs an atomic hold', async () => {
    const s = await makeSalon();
    const d = futureDate(5);
    const a = await customer('A');
    const h = await a.call(hold.POST, { params: { slug: s.slug }, body: { items: [{ key: 'x', service_id: s.services.color, staff_id: s.staff.sara, start: at(d, '10:00') }] }, idempotencyKey: true });
    await a.call(checkout.POST, { params: { slug: s.slug, id: h.body.data.booking_id }, body: { option: 'on_site' }, idempotencyKey: true });

    const noConsent = await customer('NoConsent');
    expect((await noConsent.call(join.POST, { params: { slug: s.slug }, body: { service_id: s.services.color, staff_id: s.staff.sara, desired_from: d, desired_to: d, notify_consent: false } })).status).toBe(201);
    const b = await customer('B');
    const c = await customer('C');
    for (const x of [b, c]) expect((await x.call(join.POST, { params: { slug: s.slug }, body: { service_id: s.services.color, staff_id: s.staff.sara, desired_from: d, desired_to: d, notify_consent: true } })).status).toBe(201);
    // Duplicate join is rejected.
    expect((await b.call(join.POST, { params: { slug: s.slug }, body: { service_id: s.services.color, desired_from: d, desired_to: d, notify_consent: true } })).status).toBe(409);

    await a.call(accountCancel.POST, { params: { id: h.body.data.booking_id }, body: { reason: 'cannot come' } });
    const offers = await withTenant(s.tenantId, (trx) => trx.selectFrom('waitlist_offers as o').innerJoin('waitlist_entries as e', 'e.id', 'o.waitlist_entry_id')
      .innerJoin('tenant_customers as t', 't.id', 'e.tenant_customer_id').select(['o.id', 'o.status', 't.display_name']).execute());
    expect(offers).toHaveLength(1);
    expect(offers[0]!.display_name).toBe('B'); // first consenting entry; the earlier no-consent entry is never contacted
    // C cannot accept B's offer.
    expect((await c.call(accept.POST, { params: { id: offers[0]!.id }, idempotencyKey: true })).status).toBe(404);
    const ok = await b.call(accept.POST, { params: { id: offers[0]!.id }, idempotencyKey: true });
    expect(ok.status).toBe(201);
    expect(ok.body.data.booking_id).toBeTruthy();
    expect((await b.call(accept.POST, { params: { id: offers[0]!.id }, idempotencyKey: true })).status).toBe(409);
  });
});

describe('group sessions', () => {
  it('never overbooks under concurrency and blocks the instructor for individual bookings', async () => {
    const s = await makeSalon();
    const svc = await s.owner.call(services.POST, { params: { tenantSlug: s.slug }, body: { name_ar: 'ورشة مكياج', price_minor: 20000, duration_min: 120, booking_mode: 'group', staff: [{ staff_id: s.staff.huda }] } });
    const d = futureDate(6);
    const g = await s.owner.call(groups.POST, { params: { tenantSlug: s.slug }, body: { branch_id: s.branchId, service_id: svc.body.data.id, staff_id: s.staff.huda, starts_at: at(d, '12:00'), capacity: 2 } });
    expect(g.status).toBe(201);
    const people = await Promise.all([customer('1'), customer('2'), customer('3')]);
    const results = await Promise.all(people.map((p) => p.call(bookGroup.POST, { params: { slug: s.slug, id: g.body.data.id }, body: { seats: 1 }, idempotencyKey: true })));
    expect(results.map((r) => r.status).sort()).toEqual([201, 201, 409]);
    const sess = await withTenant(s.tenantId, (trx) => trx.selectFrom('group_sessions').select(['seats_taken', 'capacity']).where('id', '=', g.body.data.id).executeTakeFirstOrThrow());
    expect(sess).toEqual({ seats_taken: 2, capacity: 2 });
    // Huda is busy 12:00–14:00 for individual services.
    const blocked = await people[2]!.call(hold.POST, { params: { slug: s.slug }, body: { items: [{ key: 'x', service_id: s.services.nails, staff_id: s.staff.huda, start: at(d, '13:00') }] }, idempotencyKey: true });
    expect(blocked.status).toBe(409);
    // Cancelling a seat frees it.
    const winner = results.findIndex((r) => r.status === 201);
    await people[winner]!.call(accountCancel.POST, { params: { id: results[winner]!.body.data.booking_id }, body: { reason: 'sick today' } });
    const after = await withTenant(s.tenantId, (trx) => trx.selectFrom('group_sessions').select('seats_taken').where('id', '=', g.body.data.id).executeTakeFirstOrThrow());
    expect(after.seats_taken).toBe(1);
  });
});
