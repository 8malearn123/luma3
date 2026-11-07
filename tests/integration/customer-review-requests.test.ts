import { describe, expect, it } from 'vitest';
import { at, customer, futureDate, makeSalon, type Salon } from '../helpers/salon';
import { sql, withSystem, withTenant } from '@/server/db/client';
import { transition } from '@/server/domains/booking/service';
import { sendReviewRequests } from '@/server/domains/reviews/requests';
import { resolveTenantAccess } from '@/server/tenancy/access';
import { resolveSession } from '@/server/auth/service';
import * as hold from '@/app/api/v1/s/[slug]/bookings/route';
import * as checkout from '@/app/api/v1/s/[slug]/bookings/[id]/checkout/route';
import * as settings from '@/app/api/v1/t/[tenantSlug]/settings/route';
import * as reviewSettings from '@/app/api/v1/t/[tenantSlug]/settings/review-requests/route';
import * as myReviews from '@/app/api/v1/account/reviews/route';

const H = 3_600_000;

async function completedVisit(s: Salon, day = 3, time = '10:00') {
  const c = await customer('Visit customer');
  const h = await c.call(hold.POST, { params: { slug: s.slug }, body: { items: [{ key: 'a', service_id: s.services.haircut, staff_id: s.staff.sara, start: at(futureDate(day), time) }] }, idempotencyKey: true });
  const id = h.body.data.booking_id as string;
  await c.call(checkout.POST, { params: { slug: s.slug, id }, body: { option: 'on_site' }, idempotencyKey: true });
  const owner = await resolveSession(s.owner.cookies.get('luma_session'));
  const access = await resolveTenantAccess(owner!, s.slug);
  const b = await withTenant(s.tenantId, (trx) => trx.selectFrom('bookings').select(['starts_at', 'customer_user_id']).where('id', '=', id).executeTakeFirstOrThrow());
  const actor = { kind: 'staff' as const, access, audit: { userId: owner!.userId, kind: 'user' as const } };
  const now = new Date(b.starts_at.getTime() + 60_000);
  await transition(s.tenantId, id, 'check_in', actor, { now });
  await transition(s.tenantId, id, 'complete', actor, { now });
  return { c, id, userId: b.customer_user_id! };
}

async function configure(s: Salon, body: Record<string, unknown>) {
  const cur = await s.owner.call(settings.GET, { params: { tenantSlug: s.slug } });
  const r = await s.owner.call(reviewSettings.PUT, { params: { tenantSlug: s.slug }, body: { ...body, version: cur.body.data.settings.version } });
  expect(r.status).toBe(200);
}

const notes = (tenantId: string, userId: string) => withTenant(tenantId, (trx) => trx.selectFrom('notifications').select(['kind', 'target_path'])
  .where('user_id', '=', userId).where('kind', 'like', 'review.%').orderBy('created_at').execute());
const outbox = (bookingId: string) => withSystem('test', (trx) => trx.selectFrom('outbox_events').select('topic')
  .where('topic', 'like', 'review.%').where(sql<boolean>`payload->>'booking_id' = ${bookingId}`).orderBy('created_at').execute());

describe('review request after the visit', () => {
  it('waits the owner-chosen delay, sends once (in-app + messaging outbox), then one reminder', async () => {
    const s = await makeSalon();
    await configure(s, { review_request_mode: 'after_hours', review_request_delay_hours: 4, review_reminder_hours: 24 });
    const v = await completedVisit(s);
    const t0 = Date.now();

    await sendReviewRequests(new Date(t0 + 1 * H));
    expect(await notes(s.tenantId, v.userId)).toEqual([]);

    await sendReviewRequests(new Date(t0 + 4 * H + 60_000));
    expect(await notes(s.tenantId, v.userId)).toEqual([{ kind: 'review.request', target_path: '/account/reviews' }]);
    expect(await outbox(v.id)).toEqual([{ topic: 'review.request' }]);
    // Idempotent: another run sends nothing new.
    await sendReviewRequests(new Date(t0 + 5 * H));
    expect(await notes(s.tenantId, v.userId)).toHaveLength(1);

    // One reminder 24 h after the first request; never twice.
    await sendReviewRequests(new Date(t0 + 20 * H));
    expect(await notes(s.tenantId, v.userId)).toHaveLength(1);
    await sendReviewRequests(new Date(t0 + 30 * H));
    await sendReviewRequests(new Date(t0 + 60 * H));
    expect((await notes(s.tenantId, v.userId)).map((n) => n.kind)).toEqual(['review.request', 'review.reminder']);
    expect((await outbox(v.id)).map((o) => o.topic)).toEqual(['review.request', 'review.reminder']);
    const rr = await withTenant(s.tenantId, (trx) => trx.selectFrom('review_requests').select(['status', 'reminder_sent_at']).where('booking_id', '=', v.id).executeTakeFirstOrThrow());
    expect(rr.status).toBe('reminded');
  });

  it('immediately mode asks on the next run; no reminder after she reviewed; off never asks', async () => {
    const s = await makeSalon();
    await configure(s, { review_request_mode: 'immediately', review_reminder_hours: 2 });
    const v = await completedVisit(s, 3, '10:00');
    await sendReviewRequests(new Date(Date.now() + 60_000));
    expect((await notes(s.tenantId, v.userId)).map((n) => n.kind)).toEqual(['review.request']);
    // She opens /account/reviews and reviews the visit → the reminder is never sent.
    const pending = await v.c.call(myReviews.GET);
    expect(pending.body.data.pending.map((p: any) => p.id)).toContain(v.id);
    expect((await v.c.call(myReviews.POST, { body: { booking_id: v.id, rating: 5 } })).status).toBe(201);
    await sendReviewRequests(new Date(Date.now() + 10 * H));
    expect((await notes(s.tenantId, v.userId)).map((n) => n.kind)).toEqual(['review.request']);
    const rr = await withTenant(s.tenantId, (trx) => trx.selectFrom('review_requests').select('status').where('booking_id', '=', v.id).executeTakeFirstOrThrow());
    expect(rr.status).toBe('reviewed');

    const off = await makeSalon();
    await configure(off, { review_request_mode: 'off' });
    const w = await completedVisit(off);
    await sendReviewRequests(new Date(Date.now() + 100 * H));
    expect(await notes(off.tenantId, w.userId)).toEqual([]);
  });

  it('validates the owner setting and requires business.manage', async () => {
    const s = await makeSalon();
    const cur = await s.owner.call(reviewSettings.GET, { params: { tenantSlug: s.slug } });
    expect(cur.body.data).toMatchObject({ review_request_mode: 'after_hours', review_request_delay_hours: 3, review_reminder_hours: null });
    const bad = await s.owner.call(reviewSettings.PUT, { params: { tenantSlug: s.slug }, body: { review_request_mode: 'after_hours', review_request_delay_hours: 500, version: cur.body.data.version } });
    expect(bad.status).toBe(422);
    const stale = await s.owner.call(reviewSettings.PUT, { params: { tenantSlug: s.slug }, body: { review_request_mode: 'off', version: cur.body.data.version + 7 } });
    expect(stale.status).toBe(409);
    const c = await customer('Not staff');
    expect((await c.call(reviewSettings.PUT, { params: { tenantSlug: s.slug }, body: { review_request_mode: 'off', version: 1 } })).status).toBe(404);
  });
});
