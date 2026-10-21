import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createBusinessFor, signup } from '../helpers/factory';
import { TestClient } from '../helpers/http';
import { addBooking, addCustomer, addReview, addService, addStaff, at, ownerUserId, publishStorefront } from '../helpers/marketing-data';
import * as events from '@/app/api/v1/s/[slug]/events/route';
import * as summary from '@/app/api/v1/t/[tenantSlug]/analytics/summary/route';
import * as occupancy from '@/app/api/v1/t/[tenantSlug]/analytics/occupancy/route';
import * as team from '@/app/api/v1/t/[tenantSlug]/analytics/team/route';
import * as demand from '@/app/api/v1/t/[tenantSlug]/analytics/demand/route';
import * as invitations from '@/app/api/v1/t/[tenantSlug]/invitations/route';
import * as accept from '@/app/api/v1/invitations/accept/route';
import { withTenant } from '@/server/db/client';
import { recordServerEvent } from '@/server/domains/analytics/events';
import { rollupTenant } from '@/server/domains/analytics/jobs';
import { localToday } from '@/server/domains/analytics/period';

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';
const DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';

function ev(type: string, session: string, extra: Record<string, unknown> = {}) {
  return { event_id: randomUUID(), session_id: session, type, occurred_at: new Date().toISOString(), path: '/s/x', ...extra };
}

async function publishedBiz() {
  const owner = await signup('Owner');
  const biz = await createBusinessFor(owner, { plan_code: 'wahaj' });
  await publishStorefront(biz, await ownerUserId(biz));
  return { owner, biz };
}

async function send(c: TestClient, slug: string, body: unknown, ua = UA, headers: Record<string, string> = {}) {
  return c.call(events.POST, { params: { slug }, body, headers: { 'user-agent': ua, ...headers } });
}

describe('storefront analytics ingestion', () => {
  it('dedupes by event_id and requires the CSRF header; browsers cannot claim conversions', async () => {
    const { owner, biz } = await publishedBiz();
    const visitor = new TestClient();
    const e = ev('page_view', 'sess-dedupe-1');
    expect((await send(visitor, biz.slug, e)).status).toBe(202);
    expect((await send(visitor, biz.slug, e)).status).toBe(202);
    const rows = await withTenant(biz.tenantId, (trx) => trx.selectFrom('analytics_events').select('id').where('id', '=', e.event_id).execute());
    expect(rows).toHaveLength(1);
    const noCsrf = await visitor.call(events.POST, { params: { slug: biz.slug }, body: ev('page_view', 'sess-dedupe-1'), csrf: false, headers: { 'user-agent': UA } });
    expect(noCsrf.status).toBe(403);
    expect((await send(visitor, biz.slug, ev('booking_confirmed', 'sess-dedupe-1'))).status).toBe(422);
    expect((await send(visitor, biz.slug, { ...ev('page_view', 'sess-dedupe-1'), tenant_id: biz.tenantId })).status).toBe(422);
    const s = await owner.call(summary.GET, { params: { tenantSlug: biz.slug } });
    expect(s.body.data.totals.page_views).toBe(1);
  });

  it('flags previews, builder activity, signed-in members and bots as excluded (stored, not counted)', async () => {
    const owner = await signup('Owner');
    const biz = await createBusinessFor(owner, { plan_code: 'wahaj' });
    const visitor = new TestClient();
    // Unpublished storefront → only owner previews can produce traffic.
    await send(visitor, biz.slug, ev('page_view', 'sess-preview-1'));
    await publishStorefront(biz, await ownerUserId(biz));
    await send(visitor, biz.slug, ev('page_view', 'sess-builder-1'), UA, { referer: `http://localhost:3000/app/${biz.slug}/builder` });
    await send(visitor, biz.slug, ev('page_view', 'sess-preview-2', { path: '/preview/abc' }));
    await send(owner, biz.slug, ev('page_view', 'sess-member-1'));
    await send(visitor, biz.slug, ev('page_view', 'sess-bot-1'), 'Googlebot/2.1 (+http://www.google.com/bot.html)');
    await send(visitor, biz.slug, ev('page_view', 'sess-bot-2'), 'HeadlessChrome/120');
    await send(visitor, biz.slug, ev('page_view', 'sess-real-1', { referrer: 'https://www.instagram.com/some/path?x=1' }));
    const rows = await withTenant(biz.tenantId, (trx) => trx.selectFrom('analytics_events').select(['session_id', 'is_excluded', 'exclusion_reason', 'referrer_host', 'device']).execute());
    const by = Object.fromEntries(rows.map((r) => [r.session_id, r]));
    expect(by['sess-preview-1']!.exclusion_reason).toBe('preview');
    expect(by['sess-builder-1']!.exclusion_reason).toBe('builder');
    expect(by['sess-preview-2']!.exclusion_reason).toBe('preview');
    expect(by['sess-member-1']!.exclusion_reason).toBe('member');
    expect(by['sess-bot-1']!.exclusion_reason).toBe('bot');
    expect(by['sess-bot-2']!.exclusion_reason).toBe('bot');
    expect(by['sess-real-1']!.is_excluded).toBe(false);
    expect(by['sess-real-1']!.referrer_host).toBe('instagram.com');
    expect(by['sess-real-1']!.device).toBe('mobile');
    const s = await owner.call(summary.GET, { params: { tenantSlug: biz.slug } });
    expect(s.body.data.totals.sessions).toBe(1);
    expect(s.body.data.totals.excluded_events).toBe(6);
    expect(s.body.data.sources[0]).toEqual({ key: 'instagram.com', sessions: 1 });
  });

  it('defines conversion rate per eligible session and reports bookings/session separately (can exceed 1)', async () => {
    const { owner, biz } = await publishedBiz();
    const v = new TestClient();
    await send(v, biz.slug, ev('page_view', 'sess-conv-A'));
    await send(v, biz.slug, ev('booking_start', 'sess-conv-A'));
    await send(v, biz.slug, ev('page_view', 'sess-conv-B'), DESKTOP);
    // The same iframe/session reloading is still one session.
    await send(v, biz.slug, ev('page_view', 'sess-conv-B'), DESKTOP);
    await withTenant(biz.tenantId, async (trx) => {
      for (let i = 0; i < 3; i++) await recordServerEvent(trx, biz.tenantId, { type: 'booking_confirmed', entityId: randomUUID(), sessionId: 'sess-conv-A' });
      // Not linked to a session: counted in totals, never as a session.
      await recordServerEvent(trx, biz.tenantId, { type: 'booking_confirmed', entityId: randomUUID() });
      const dup = randomUUID();
      await recordServerEvent(trx, biz.tenantId, { type: 'order_paid', entityId: dup });
      const again = await recordServerEvent(trx, biz.tenantId, { type: 'order_paid', entityId: dup });
      expect(again.recorded).toBe(false);
    });
    const s = await owner.call(summary.GET, { params: { tenantSlug: biz.slug } });
    const d = s.body.data;
    expect(d.totals.sessions).toBe(2);
    expect(d.totals.conversion_sessions).toBe(1);
    expect(d.totals.bookings_confirmed).toBe(4);
    expect(d.totals.orders_paid).toBe(1);
    expect(d.rates.conversion_rate).toBe(0.5);
    expect(d.rates.bookings_per_session).toBe(1.5);
    expect(d.devices.map((x: any) => x.key).sort()).toEqual(['desktop', 'mobile']);

    // Rollup is idempotent per tenant-local day.
    await rollupTenant(biz.tenantId);
    await rollupTenant(biz.tenantId);
    const today = localToday('Asia/Riyadh');
    const m = await withTenant(biz.tenantId, (trx) => trx.selectFrom('daily_metrics').select(['metric', 'value']).where('day', '=', today).where('dimension', '=', '').execute());
    const sessions = m.filter((r) => r.metric === 'sessions');
    expect(sessions).toHaveLength(1);
    expect(Number(sessions[0]!.value)).toBe(2);
  });

  it('keeps demand signals separate (a view is not a booking)', async () => {
    const { owner, biz } = await publishedBiz();
    const svc = await addService(biz, { name: 'Facial' });
    const v = new TestClient();
    await send(v, biz.slug, ev('service_view', 'sess-dem-1', { entity_id: svc }));
    await send(v, biz.slug, ev('availability_empty', 'sess-dem-1', { entity_id: svc }));
    const r = await owner.call(demand.GET, { params: { tenantSlug: biz.slug } });
    const row = r.body.data.services.find((x: any) => x.service_id === svc);
    expect(row).toMatchObject({ views: 1, availability_empty: 1, confirmed: 0, completed: 0 });
  });
});

describe('occupancy', () => {
  it('divides booked minutes by available minutes after breaks, leave and overrides', async () => {
    const owner = await signup('Owner');
    const biz = await createBusinessFor(owner, { plan_code: 'wahaj' });
    const staff = await addStaff(biz, 'Huda');
    const svc = await addService(biz);
    const cust = await addCustomer(biz);
    await withTenant(biz.tenantId, async (trx) => {
      // Sundays 09:00–17:00 with a 13:00–14:00 break (Riyadh) → 420 min/day.
      await trx.insertInto('working_hours').values({ tenant_id: biz.tenantId, staff_id: staff, branch_id: biz.branchId, weekday: 0, start_time: '09:00', end_time: '17:00' }).execute();
      await trx.insertInto('staff_breaks').values({ tenant_id: biz.tenantId, staff_id: staff, weekday: 0, start_time: '13:00', end_time: '14:00' }).execute();
      // Approved leave covers the second Sunday entirely; a requested (not approved) leave is ignored.
      await trx.insertInto('leave_requests').values({ tenant_id: biz.tenantId, staff_id: staff, during: '[2026-10-18 00:00+03,2026-10-19 00:00+03)', status: 'approved' }).execute();
      await trx.insertInto('leave_requests').values({ tenant_id: biz.tenantId, staff_id: staff, during: '[2026-10-11 15:00+03,2026-10-11 17:00+03)', status: 'requested' }).execute();
      // Saturday extra shift via override (2h).
      await trx.insertInto('shift_overrides').values({ tenant_id: biz.tenantId, staff_id: staff, branch_id: biz.branchId, on_date: '2026-10-17', kind: 'extra', start_time: '10:00', end_time: '12:00' }).execute();
    });
    await addBooking(biz, { customerId: cust, serviceId: svc, staffId: staff, startsAt: at('2026-10-11T07:00:00Z'), durationMin: 120, status: 'confirmed' }); // 10:00–12:00 local
    await addBooking(biz, { customerId: cust, serviceId: svc, staffId: staff, startsAt: at('2026-10-11T10:00:00Z'), durationMin: 30, status: 'completed' }); // 13:00–13:30 during break
    await addBooking(biz, { customerId: cust, serviceId: svc, staffId: staff, startsAt: at('2026-10-11T12:00:00Z'), durationMin: 60, status: 'cancelled' }); // ignored
    await addBooking(biz, { customerId: cust, serviceId: svc, staffId: staff, startsAt: at('2026-10-17T07:00:00Z'), durationMin: 60, status: 'completed' }); // Sat 10:00–11:00

    const r = await owner.call(occupancy.GET, { params: { tenantSlug: biz.slug }, query: { from: '2026-10-11', to: '2026-10-18', staff_id: staff } });
    expect(r.status).toBe(200);
    const s = r.body.data.staff[0];
    expect(s.available_min).toBe(420 + 120); // Sunday 11th + Saturday extra; Sunday 18th on leave
    expect(s.booked_min).toBe(120 + 60);
    expect(s.booked_outside_min).toBe(30);
    expect(s.occupancy).toBeCloseTo(180 / 540, 5);
  });
});

describe('employee indicators', () => {
  it('reports insufficient data for small samples and lets a specialist see only herself', async () => {
    const owner = await signup('Owner');
    const biz = await createBusinessFor(owner, { plan_code: 'wahaj' });
    const spUser = await signup('Specialist');
    const mine = await addStaff(biz, 'Mine');
    const other = await addStaff(biz, 'Colleague');
    const svc = await addService(biz);
    const cust = await addCustomer(biz);
    const b = await addBooking(biz, { customerId: cust, serviceId: svc, staffId: mine, startsAt: new Date(Date.now() - 5 * 86_400_000), actualStart: new Date(Date.now() - 5 * 86_400_000 + 20 * 60_000), actualEnd: new Date(Date.now() - 5 * 86_400_000 + 90 * 60_000) });
    await addReview(biz, b, cust, 5, mine);
    await addBooking(biz, { customerId: cust, serviceId: svc, staffId: other, startsAt: new Date(Date.now() - 4 * 86_400_000) });

    const r = await owner.call(team.GET, { params: { tenantSlug: biz.slug } });
    expect(r.status).toBe(200);
    expect(r.body.data.scope).toBe('team');
    const row = r.body.data.staff.find((x: any) => x.staff_id === mine);
    expect(row.indicators.satisfaction).toMatchObject({ status: 'insufficient_data', value: null, n: 1 });
    expect(row.indicators.punctuality.status).toBe('insufficient_data');
    expect(row.composite.status).toBe('insufficient_data');
    expect(row.execution.avg_actual_min).toBeCloseTo(70, 3); // actual elapsed, not catalog duration
    expect(row.execution.avg_planned_min).toBe(60);

    const inv = await owner.call(invitations.POST, { params: { tenantSlug: biz.slug }, body: { identifier: spUser.identifier, role: 'specialist', staff_profile_id: mine } });
    expect(inv.status).toBe(201);
    await spUser.call(accept.POST, { body: { token: inv.body.data.dev_invite_link.split('/invite/')[1] } });
    const own = await spUser.call(team.GET, { params: { tenantSlug: biz.slug } });
    expect(own.status).toBe(200);
    expect(own.body.data.scope).toBe('self');
    expect(own.body.data.staff.map((x: any) => x.staff_id)).toEqual([mine]);
    expect((await spUser.call(summary.GET, { params: { tenantSlug: biz.slug } })).status).toBe(403);
  });
});
