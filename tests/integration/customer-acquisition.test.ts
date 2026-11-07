import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { at, customer, futureDate, makeSalon, type Salon } from '../helpers/salon';
import { TestClient } from '../helpers/http';
import { uniq } from '../helpers/factory';
import { withTenant } from '@/server/db/client';
import { classifyAttribution } from '@/shared/acquisition';
import * as events from '@/app/api/v1/s/[slug]/events/route';
import * as hold from '@/app/api/v1/s/[slug]/bookings/route';
import * as acquisition from '@/app/api/v1/s/[slug]/acquisition/route';
import * as customersRoute from '@/app/api/v1/t/[tenantSlug]/customers/route';
import * as report from '@/app/api/v1/t/[tenantSlug]/analytics/acquisition/route';
import * as register from '@/app/api/v1/auth/register/route';
import * as verify from '@/app/api/v1/auth/verify/route';

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';

async function visit(c: TestClient, slug: string, session: string, extra: Record<string, unknown> = {}) {
  const r = await c.call(events.POST, { params: { slug }, headers: { 'user-agent': UA }, body: { event_id: randomUUID(), session_id: session, type: 'page_view', occurred_at: new Date().toISOString(), path: `/s/${slug}`, ...extra } });
  expect(r.status).toBe(202);
}

let slot = 0;
async function bookWithSession(s: Salon, c: TestClient, session: string | null) {
  const start = at(futureDate(3 + (slot % 5)), `${10 + Math.floor(slot / 5) % 7}:00`);
  slot++;
  const r = await c.call(hold.POST, { params: { slug: s.slug }, body: { items: [{ key: 'a', service_id: s.services.haircut, start, staff_id: slot % 2 ? s.staff.sara : s.staff.huda }] }, idempotencyKey: true, headers: session ? { 'x-luma-session': session } : {} });
  expect(r.status).toBe(201);
  return r.body.data as { booking_id: string; acquisition_question: boolean };
}

const source = (s: Salon, bookingId: string) => withTenant(s.tenantId, (trx) => trx.selectFrom('bookings as b').innerJoin('tenant_customers as c', 'c.id', 'b.tenant_customer_id')
  .select(['c.acquisition_source', 'c.acquisition_method', 'c.acquisition_detail']).where('b.id', '=', bookingId).executeTakeFirstOrThrow());

describe('acquisition source («كيف عرفتِ عنا؟»)', () => {
  it('classifies first-touch attribution', () => {
    expect(classifyAttribution({ utm: { medium: 'referral', source: 'ambassador' } })).toBe('referral');
    expect(classifyAttribution({ utm: { source: 'luma_marketplace' } })).toBe('marketplace');
    expect(classifyAttribution({ utm: { source: 'luma', medium: 'in_app', campaign: 'eid' } })).toBe('campaign');
    expect(classifyAttribution({ utm: { source: 'instagram', medium: 'social' } })).toBe('instagram');
    expect(classifyAttribution({ referrerHost: 'l.instagram.com' })).toBe('instagram');
    expect(classifyAttribution({ referrerHost: 'tiktok.com' })).toBe('tiktok');
    expect(classifyAttribution({ referrerHost: 'snapchat.com' })).toBe('snapchat');
    expect(classifyAttribution({ referrerHost: 'google.com.sa' })).toBe('google');
    expect(classifyAttribution({ referrerHost: 'blog.example.com' })).toBe('website');
    expect(classifyAttribution({})).toBe('direct');
  });

  it('infers from the storefront session at booking and never overwrites a specific first touch', async () => {
    const s = await makeSalon();
    const c = await customer('From Instagram');
    const sid = `sess-${uniq()}-ig`;
    await visit(c, s.slug, sid, { referrer: 'https://l.instagram.com/?u=x' });
    await visit(c, s.slug, sid, { path: `/s/${s.slug}/services` });
    const b = await bookWithSession(s, c, sid);
    expect(b.acquisition_question).toBe(false);
    expect(await source(s, b.booking_id)).toMatchObject({ acquisition_source: 'instagram', acquisition_method: 'inferred', acquisition_detail: expect.objectContaining({ referrer_host: 'l.instagram.com', session_id: sid }) });
    // Later she comes from a TikTok campaign: first touch stays Instagram; and she is not asked.
    const sid2 = `sess-${uniq()}-tt`;
    await visit(c, s.slug, sid2, { utm: { source: 'tiktok', campaign: 'summer' } });
    const b2 = await bookWithSession(s, c, sid2);
    expect((await source(s, b2.booking_id)).acquisition_source).toBe('instagram');
    expect((await c.call(acquisition.GET, { params: { slug: s.slug } })).body.data.needs_question).toBe(false);
    expect((await c.call(acquisition.POST, { params: { slug: s.slug }, body: { source: 'friend' } })).body.data.changed).toBe(false);

    const camp = await customer('From campaign');
    const sid3 = `sess-${uniq()}-cp`;
    await visit(camp, s.slug, sid3, { utm: { source: 'luma', medium: 'in_app', campaign: 'EID24' } });
    expect((await source(s, (await bookWithSession(s, camp, sid3)).booking_id)).acquisition_source).toBe('campaign');
  });

  it('asks only when unknown (or merely direct), and uses the registration answer once as the fallback', async () => {
    const s = await makeSalon();
    // No analytics session at all → unknown → asked.
    const c = await customer('Unknown source');
    const b = await bookWithSession(s, c, null);
    expect(b.acquisition_question).toBe(true);
    expect((await source(s, b.booking_id)).acquisition_source).toBeNull();
    expect((await c.call(acquisition.GET, { params: { slug: s.slug } })).body.data.needs_question).toBe(true);
    const ans = await c.call(acquisition.POST, { params: { slug: s.slug }, body: { source: 'friend' } });
    expect(ans.body.data).toEqual({ source: 'friend', changed: true });
    expect(await source(s, b.booking_id)).toMatchObject({ acquisition_source: 'friend', acquisition_method: 'asked' });
    expect((await c.call(acquisition.GET, { params: { slug: s.slug } })).body.data.needs_question).toBe(false);
    expect((await c.call(acquisition.POST, { params: { slug: s.slug }, body: { source: 'nonsense' } })).status).toBe(422);

    // Typed the URL (session without referrer/UTM) → 'direct', still offered the question.
    const d = await customer('Direct visitor');
    const sid = `sess-${uniq()}-dr`;
    await visit(d, s.slug, sid);
    const bd = await bookWithSession(s, d, sid);
    expect(bd.acquisition_question).toBe(true);
    expect(await source(s, bd.booking_id)).toMatchObject({ acquisition_source: 'direct', acquisition_method: 'inferred' });

    // Answer given at registration: used as the fallback for the first business she books with.
    const r = new TestClient();
    const identifier = `u-${uniq()}@example.test`;
    const reg = await r.call(register.POST, { body: { identifier, password: 'correct horse battery', display_name: 'Registered', heard_from: 'tiktok' } });
    expect(reg.status).toBe(202);
    await r.call(verify.POST, { body: { identifier, code: reg.body.data.delivery.dev_code } });
    const br = await bookWithSession(s, r, null);
    expect(br.acquisition_question).toBe(false);
    expect(await source(s, br.booking_id)).toMatchObject({ acquisition_source: 'tiktok', acquisition_method: 'asked' });
    // Used once: another business she books with is not attributed to it.
    const s2 = await makeSalon();
    const br2 = await bookWithSession(s2, r, null);
    expect((await source(s2, br2.booking_id)).acquisition_source).toBeNull();

    // Customer list filter + analytics.
    const list = await s.owner.call(customersRoute.GET, { params: { tenantSlug: s.slug }, query: { acquisition: 'tiktok' } });
    expect(list.status).toBe(200);
    expect(list.body.data.items.map((x: any) => x.display_name)).toEqual(['Registered']);
    expect(list.body.data.items[0]).toMatchObject({ acquisition_source: 'tiktok', acquisition_method: 'asked' });
    const rep = await s.owner.call(report.GET, { params: { tenantSlug: s.slug } });
    expect(rep.status).toBe(200);
    const by = Object.fromEntries(rep.body.data.sources.map((x: any) => [x.source, x.customers]));
    expect(by).toMatchObject({ friend: 1, direct: 1, tiktok: 1 });
    expect(rep.body.data.total).toBe(3);
  });
});
