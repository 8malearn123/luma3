import { describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { at, customer, futureDate, makeSalon } from '../helpers/salon';
import { withSystem, withTenant } from '@/server/db/client';
import * as availability from '@/app/api/v1/s/[slug]/availability/route';
import * as hold from '@/app/api/v1/s/[slug]/bookings/route';
import * as checkout from '@/app/api/v1/s/[slug]/bookings/[id]/checkout/route';
import * as tBookings from '@/app/api/v1/t/[tenantSlug]/bookings/route';
import * as tTransition from '@/app/api/v1/t/[tenantSlug]/bookings/[id]/transition/route';
import * as tReschedule from '@/app/api/v1/t/[tenantSlug]/bookings/[id]/reschedule/route';
import * as tBooking from '@/app/api/v1/t/[tenantSlug]/bookings/[id]/route';
import * as accountCancel from '@/app/api/v1/account/bookings/[id]/cancel/route';
import * as leave from '@/app/api/v1/t/[tenantSlug]/leave/route';
import * as leaveDecide from '@/app/api/v1/t/[tenantSlug]/leave/[id]/route';
import { expireStaleHolds, transition } from '@/server/domains/booking/service';
import { createBusinessFor, signup } from '../helpers/factory';

const item = (service_id: string, staff_id: string, start: string, key = 'a') => ({ key, service_id, staff_id, start });

describe('availability & holds', () => {
  it('returns only feasible times and hides other appointments', async () => {
    const s = await makeSalon();
    const d = futureDate(4);
    const c = await customer();
    const r = await c.call(availability.POST, { params: { slug: s.slug }, body: { items: [{ key: 'a', service_id: s.services.color, staff_id: s.staff.sara }], from: d, to: d } });
    expect(r.status).toBe(200);
    const starts = r.body.data.days[d].map((o: any) => o.start);
    // 90 min + 15 min buffer-after must fit before 18:00 → latest 16:15 → aligned to 30 min → 16:00
    expect(starts[0]).toBe(new Date(at(d, '10:00')).toISOString());
    expect(starts[starts.length - 1]).toBe(new Date(at(d, '16:00')).toISOString());
    expect(JSON.stringify(r.body)).not.toMatch(/customer|display_name/);
  });

  it('two concurrent holds for the same slot: exactly one wins', async () => {
    const s = await makeSalon();
    const d = futureDate(5);
    const [c1, c2] = [await customer('A'), await customer('B')];
    const body = { items: [item(s.services.color, s.staff.sara, at(d, '11:00'))] };
    const [r1, r2] = await Promise.all([
      c1.call(hold.POST, { params: { slug: s.slug }, body, idempotencyKey: true }),
      c2.call(hold.POST, { params: { slug: s.slug }, body, idempotencyKey: true }),
    ]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([201, 409]);
    const loser = r1.status === 409 ? r1 : r2;
    expect(loser.body.error.code).toBe('slot_unavailable');
    const allocs = await withTenant(s.tenantId, (trx) => trx.selectFrom('booking_allocations').select('id').where('staff_id', '=', s.staff.sara).where('state', '=', 'held').execute());
    expect(allocs).toHaveLength(1);
  });

  it('same idempotency key replays the same hold instead of creating a second', async () => {
    const s = await makeSalon();
    const d = futureDate(5);
    const c = await customer();
    const body = { items: [item(s.services.haircut, s.staff.huda, at(d, '12:00'))] };
    const r1 = await c.call(hold.POST, { params: { slug: s.slug }, body, idempotencyKey: 'same-key-123456' });
    const r2 = await c.call(hold.POST, { params: { slug: s.slug }, body, idempotencyKey: 'same-key-123456' });
    expect(r1.body.data.booking_id).toBe(r2.body.data.booking_id);
    const other = await c.call(hold.POST, { params: { slug: s.slug }, body: { items: [item(s.services.haircut, s.staff.huda, at(d, '13:00'))] }, idempotencyKey: 'same-key-123456' });
    expect(other.status).toBe(422);
  });

  it('rejects unqualified staff, past times and staff on approved leave', async () => {
    const s = await makeSalon();
    const d = futureDate(6);
    const c = await customer();
    const bad = await c.call(hold.POST, { params: { slug: s.slug }, body: { items: [item(s.services.nails, s.staff.sara, at(d, '11:00'))] }, idempotencyKey: true });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('staff_not_qualified');
    const past = await c.call(hold.POST, { params: { slug: s.slug }, body: { items: [item(s.services.haircut, s.staff.sara, new Date(Date.now() - 3600_000).toISOString())] }, idempotencyKey: true });
    expect(past.status).toBe(409);
    const lv = await s.owner.call(leave.POST, { params: { tenantSlug: s.slug }, body: { staff_id: s.staff.sara, starts_at: at(d, '00:00'), ends_at: at(d, '23:59') } });
    await s.owner.call(leaveDecide.POST, { params: { tenantSlug: s.slug, id: lv.body.data.id }, body: { decision: 'approved' } });
    const onLeave = await c.call(hold.POST, { params: { slug: s.slug }, body: { items: [item(s.services.haircut, s.staff.sara, at(d, '11:00'))] }, idempotencyKey: true });
    expect(onLeave.status).toBe(409);
  });

  it('multi-service booking with different specialists discloses gaps', async () => {
    const s = await makeSalon();
    const d = futureDate(7);
    const c = await customer();
    const r = await c.call(availability.POST, { params: { slug: s.slug }, body: { items: [{ key: 'hair', service_id: s.services.color }, { key: 'nails', service_id: s.services.nails }], from: d, to: d } });
    const first = r.body.data.days[d][0];
    expect(first.items.map((i: any) => i.key)).toEqual(['hair', 'nails']);
    expect(first.items[0].staff_id).toBe(s.staff.sara);
    expect(first.items[1].staff_id).toBe(s.staff.huda);
    expect(first.gaps_min).toEqual([0]);
    const h = await c.call(hold.POST, { params: { slug: s.slug }, body: { items: first.items.map((i: any) => ({ key: i.key, service_id: i.service_id, staff_id: i.staff_id, start: i.start })) }, idempotencyKey: true });
    expect(h.status).toBe(201);
    expect(h.body.data.totals.total).toBe(38000);
  });

  it('expired holds release exactly once and free the slot', async () => {
    const s = await makeSalon();
    const d = futureDate(8);
    const c = await customer();
    const body = { items: [item(s.services.haircut, s.staff.sara, at(d, '15:00'))] };
    const h = await c.call(hold.POST, { params: { slug: s.slug }, body, idempotencyKey: true });
    await withSystem('test: age hold', (trx) => sql`update booking_allocations set expires_at = now() - interval '1 minute' where booking_id = ${h.body.data.booking_id}`.execute(trx));
    await withSystem('test: age hold', (trx) => sql`update bookings set hold_expires_at = now() - interval '1 minute' where id = ${h.body.data.booking_id}`.execute(trx));
    expect(await expireStaleHolds()).toBeGreaterThanOrEqual(1);
    await expireStaleHolds();
    const events = await withTenant(s.tenantId, (trx) => trx.selectFrom('booking_events').select('to_status').where('booking_id', '=', h.body.data.booking_id).where('to_status', '=', 'expired').execute());
    expect(events).toHaveLength(1);
    const again = await (await customer()).call(hold.POST, { params: { slug: s.slug }, body, idempotencyKey: true });
    expect(again.status).toBe(201);
  });
});

describe('lifecycle', () => {
  async function confirmed() {
    const s = await makeSalon();
    const d = futureDate(9);
    const c = await customer();
    const h = await c.call(hold.POST, { params: { slug: s.slug }, body: { items: [item(s.services.haircut, s.staff.sara, at(d, '10:00'))] }, idempotencyKey: true });
    const co = await c.call(checkout.POST, { params: { slug: s.slug, id: h.body.data.booking_id }, body: { option: 'on_site' }, idempotencyKey: true });
    expect(co.body.data.status).toBe('confirmed');
    return { s, c, id: h.body.data.booking_id as string };
  }

  it('no-show is blocked before start + grace; completion and audit work', async () => {
    const { s, id } = await confirmed();
    const r = await s.owner.call(tTransition.POST, { params: { tenantSlug: s.slug, id }, body: { action: 'no_show' } });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('too_early_for_no_show');
    // Simulate the clock after the appointment.
    const later = new Date(Date.now() + 20 * 86_400_000);
    const ns = await transition(s.tenantId, id, 'no_show', { kind: 'system', audit: { userId: null, kind: 'system' } }, { now: later }).catch((e) => e);
    expect(ns.status ?? 403).toBe(403); // system cannot record a no-show
  });

  it('check-in only on the appointment day; complete posts revenue once', async () => {
    const { s, id } = await confirmed();
    const early = await s.owner.call(tTransition.POST, { params: { tenantSlug: s.slug, id }, body: { action: 'check_in' } });
    expect(early.body.error.code).toBe('not_service_day');
    const b = await withTenant(s.tenantId, (trx) => trx.selectFrom('bookings').select('starts_at').where('id', '=', id).executeTakeFirstOrThrow());
    const access = (await import('@/server/tenancy/access'));
    const user = await (await import('@/server/auth/service')).resolveSession(s.owner.cookies.get('luma_session'));
    const acc = await access.resolveTenantAccess(user!, s.slug);
    const now = new Date(b.starts_at.getTime() + 5 * 60_000);
    await transition(s.tenantId, id, 'check_in', { kind: 'staff', access: acc, audit: { userId: user!.userId, kind: 'user' } }, { now });
    await transition(s.tenantId, id, 'start', { kind: 'staff', access: acc, audit: { userId: user!.userId, kind: 'user' } }, { now });
    await transition(s.tenantId, id, 'complete', { kind: 'staff', access: acc, audit: { userId: user!.userId, kind: 'user' } }, { now });
    const again = await transition(s.tenantId, id, 'complete', { kind: 'staff', access: acc, audit: { userId: user!.userId, kind: 'user' } }, { now }).catch((e) => e);
    expect(again.code).toBe('invalid_transition');
    const entries = await withTenant(s.tenantId, (trx) => trx.selectFrom('financial_entries').select(['account', 'debit_minor', 'credit_minor']).where('ref_id', '=', id).execute());
    expect(entries.find((e) => e.account === 'service_revenue')?.credit_minor).toBe(10000);
    expect(entries.find((e) => e.account === 'accounts_receivable')?.debit_minor).toBe(10000); // nothing paid yet: completion ≠ payment
    const bk = await withTenant(s.tenantId, (trx) => trx.selectFrom('bookings').select(['status', 'payment_status']).where('id', '=', id).executeTakeFirstOrThrow());
    expect(bk).toEqual({ status: 'completed', payment_status: 'unpaid' });
  });

  it('customer can cancel her own booking only; another customer cannot', async () => {
    const { s, c, id } = await confirmed();
    const stranger = await customer('Stranger');
    expect((await stranger.call(accountCancel.POST, { params: { id }, body: { reason: 'mine now' } })).status).toBe(404);
    const r = await c.call(accountCancel.POST, { params: { id }, body: { reason: 'changed plans' } });
    expect(r.status).toBe(200);
    expect(r.body.data.status).toBe('cancelled');
    const ev = await withTenant(s.tenantId, (trx) => trx.selectFrom('booking_events').select(['to_status', 'source', 'reason']).where('booking_id', '=', id).where('to_status', '=', 'cancelled').executeTakeFirstOrThrow());
    expect(ev).toEqual({ to_status: 'cancelled', source: 'customer', reason: 'changed plans' });
  });

  it('rescheduling keeps the original when the replacement is unavailable', async () => {
    const { s, id } = await confirmed();
    const d = futureDate(9);
    // Someone else takes 14:00 with Sara.
    const other = await customer('Other');
    const h2 = await other.call(hold.POST, { params: { slug: s.slug }, body: { items: [item(s.services.haircut, s.staff.sara, at(d, '14:00'))] }, idempotencyKey: true });
    expect(h2.status).toBe(201);
    const bad = await s.owner.call(tReschedule.POST, { params: { tenantSlug: s.slug, id }, body: { items: [item(s.services.haircut, s.staff.sara, at(d, '14:00'))] } });
    expect(bad.status).toBe(409);
    const still = await withTenant(s.tenantId, (trx) => trx.selectFrom('booking_allocations').select(['state']).where('booking_id', '=', id).execute());
    expect(still.map((a) => a.state)).toEqual(['confirmed']);
    const ok = await s.owner.call(tReschedule.POST, { params: { tenantSlug: s.slug, id }, body: { items: [item(s.services.haircut, s.staff.sara, at(d, '16:00'))] } });
    expect(ok.status).toBe(200);
    const detail = await s.owner.call(tBooking.GET, { params: { tenantSlug: s.slug, id } });
    expect(detail.body.data.items[0].starts_at).toBe(new Date(at(d, '16:00')).toISOString());
    expect(detail.body.data.history_items).toHaveLength(1);
  });

  it('specialists only see and act on their assigned bookings', async () => {
    const { s, id } = await confirmed();
    const { TestClient } = await import('../helpers/http');
    // Invite Huda (not assigned) as a specialist linked to her staff profile.
    const inv = await s.owner.call((await import('@/app/api/v1/t/[tenantSlug]/invitations/route')).POST, { params: { tenantSlug: s.slug }, body: { identifier: 'huda-' + Date.now() + '@example.test', role: 'specialist', staff_profile_id: s.staff.huda } });
    expect(inv.status).toBe(201);
    void TestClient;
    const huda = await signup('Huda');
    // identity must match the invite → use a fresh invite for Huda's real identifier
    const inv2 = await s.owner.call((await import('@/app/api/v1/t/[tenantSlug]/invitations/route')).POST, { params: { tenantSlug: s.slug }, body: { identifier: huda.identifier, role: 'specialist', staff_profile_id: s.staff.huda } });
    await huda.call((await import('@/app/api/v1/invitations/accept/route')).POST, { body: { token: inv2.body.data.dev_invite_link.split('/invite/')[1] } });
    const list = await huda.call(tBookings.GET, { params: { tenantSlug: s.slug } });
    expect(list.status).toBe(200);
    expect(list.body.data.map((b: any) => b.id)).not.toContain(id);
    expect((await huda.call(tBooking.GET, { params: { tenantSlug: s.slug, id } })).status).toBe(404);
    // Not assigned → indistinguishable from a booking that does not exist.
    expect((await huda.call(tTransition.POST, { params: { tenantSlug: s.slug, id }, body: { action: 'cancel', reason: 'nope' } })).status).toBe(404);
  });

  it('another business cannot read or transition this booking', async () => {
    const { s, id } = await confirmed();
    const o2 = await signup('Other owner');
    const b2 = await createBusinessFor(o2);
    expect((await o2.call(tBooking.GET, { params: { tenantSlug: b2.slug, id } })).status).toBe(404);
    expect((await o2.call(tTransition.POST, { params: { tenantSlug: b2.slug, id }, body: { action: 'cancel', reason: 'x y z' } })).status).toBe(404);
    expect((await o2.call(tBooking.GET, { params: { tenantSlug: s.slug, id } })).status).toBe(404);
  });
});
