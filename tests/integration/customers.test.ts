import { describe, expect, it } from 'vitest';
import { withTenant } from '@/server/db/client';
import { createUnsubscribeToken, effectiveConsent, isSuppressed, unsubscribeUrl } from '@/server/domains/customers/consents';
import { listPublishedReviews } from '@/server/domains/reviews/service';
import * as customers from '@/app/api/v1/t/[tenantSlug]/customers/route';
import * as customerOne from '@/app/api/v1/t/[tenantSlug]/customers/[id]/route';
import * as customerConsents from '@/app/api/v1/t/[tenantSlug]/customers/[id]/consents/route';
import * as reviews from '@/app/api/v1/t/[tenantSlug]/reviews/route';
import * as reviewModerate from '@/app/api/v1/t/[tenantSlug]/reviews/[id]/moderate/route';
import * as reviewReply from '@/app/api/v1/t/[tenantSlug]/reviews/[id]/reply/route';
import * as accBookings from '@/app/api/v1/account/bookings/route';
import * as accConsents from '@/app/api/v1/account/consents/route';
import * as accReviews from '@/app/api/v1/account/reviews/route';
import * as accProfile from '@/app/api/v1/account/profile/route';
import * as unsubscribe from '@/app/api/v1/unsubscribe/route';
import { TestClient } from '../helpers/http';
import { createBusinessFor, signup } from '../helpers/factory';
import { addMember, hoursAgo, hoursFromNow, insertBooking, me, relationshipFor } from '../helpers/policy';

describe('customer isolation', () => {
  it('a customer at two businesses: each sees only its own relationship; /account sees both', async () => {
    const ownerA = await signup('Owner A');
    const ownerB = await signup('Owner B');
    const a = await createBusinessFor(ownerA);
    const b = await createBusinessFor(ownerB);
    const customer = await signup('Layla');
    const cu = await me(customer);
    const tcA = await relationshipFor(a.tenantId, customer);
    const tcB = await relationshipFor(b.tenantId, customer);
    await insertBooking(a.tenantId, a.branchId, { tenantCustomerId: tcA, customerUserId: cu.id, status: 'confirmed', startsAt: hoursFromNow(48) });
    await insertBooking(b.tenantId, b.branchId, { tenantCustomerId: tcB, customerUserId: cu.id, status: 'completed', startsAt: hoursAgo(48) });
    await ownerB.call(customerOne.PATCH, { params: { tenantSlug: b.slug, id: tcB }, body: { version: 1, private_notes: 'B-ONLY-NOTE', tags: ['vip'] } });

    const listA = await ownerA.call(customers.GET, { params: { tenantSlug: a.slug } });
    expect(listA.body.data.items.map((c: any) => c.id)).toEqual([tcA]);
    const detailA = await ownerA.call(customerOne.GET, { params: { tenantSlug: a.slug, id: tcA } });
    expect(detailA.body.data.bookings).toHaveLength(1);
    expect(JSON.stringify(detailA.body)).not.toContain('B-ONLY-NOTE');
    // Business A cannot read B's relationship by id.
    expect((await ownerA.call(customerOne.GET, { params: { tenantSlug: a.slug, id: tcB } })).status).toBe(404);
    expect((await ownerA.call(customerOne.PATCH, { params: { tenantSlug: a.slug, id: tcB }, body: { version: 1, display_name: 'x' } })).status).toBe(404);

    const mine = await customer.call(accBookings.GET);
    expect(mine.body.data.map((x: any) => x.tenant_id).sort()).toEqual([a.tenantId, b.tenantId].sort());
    expect(JSON.stringify(mine.body)).not.toContain('B-ONLY-NOTE');
    const up = await customer.call(accBookings.GET, { query: { scope: 'upcoming' } });
    expect(up.body.data).toHaveLength(1);
    expect(up.body.data[0].detail_path).toMatch(/^\/account\/bookings\//);
    const cons = await customer.call(accConsents.GET);
    expect(cons.body.data.map((x: any) => x.tenant_id).sort()).toEqual([a.tenantId, b.tenantId].sort());
  });

  it('a specialist (even with customers.view) cannot read private notes; a receptionist can', async () => {
    const owner = await signup('Owner');
    const biz = await createBusinessFor(owner);
    const p = { tenantSlug: biz.slug };
    const c = await owner.call(customers.POST, { params: p, body: { display_name: 'Walk-in Huda', phone: '0551112233', private_notes: 'Allergic to product X', tags: ['walk-in'] } });
    expect(c.status).toBe(201);
    const id = c.body.data.id;
    const spec = await addMember(owner, biz.slug, 'specialist');
    expect((await spec.call(customerOne.GET, { params: { ...p, id } })).status).toBe(403);
    const specViewer = await addMember(owner, biz.slug, 'specialist', ['customers.view']);
    const sv = await specViewer.call(customerOne.GET, { params: { ...p, id } });
    expect(sv.status).toBe(200);
    expect(sv.body.data).not.toHaveProperty('private_notes');
    expect(JSON.stringify(sv.body)).not.toContain('Allergic');
    expect((await specViewer.call(customerOne.PATCH, { params: { ...p, id }, body: { version: 1, private_notes: 'x' } })).status).toBe(403);
    const rec = await addMember(owner, biz.slug, 'receptionist');
    const rv = await rec.call(customerOne.GET, { params: { ...p, id } });
    expect(rv.body.data.private_notes).toBe('Allergic to product X');
  });

  it('walk-in creation never reveals whether a phone or email has a LUMA account', async () => {
    const owner = await signup('Owner');
    const biz = await createBusinessFor(owner);
    const p = { tenantSlug: biz.slug };
    const registered = await signup('Registered', { phone: true });
    const known = await owner.call(customers.POST, { params: p, body: { display_name: 'Known person', phone: registered.identifier } });
    const unknown = await owner.call(customers.POST, { params: p, body: { display_name: 'Unknown person', phone: '+966500000001' } });
    expect(known.status).toBe(201);
    expect(unknown.status).toBe(201);
    expect(Object.keys(known.body.data).sort()).toEqual(Object.keys(unknown.body.data).sort());
    expect(known.body.data.has_account).toBe(false);
    expect(unknown.body.data.has_account).toBe(false);
    // Searching this business's customers by a LUMA user's phone finds nothing unless she is a customer here.
    const outsider = await signup('Outsider', { phone: true });
    const s = await owner.call(customers.GET, { params: p, query: { q: outsider.identifier } });
    expect(s.body.data.items).toHaveLength(0);
    // Duplicate detection is limited to this business's own records.
    const dup = await owner.call(customers.POST, { params: p, body: { display_name: 'Again', phone: '+966500000001' } });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('customer_phone_exists');
  });

  it('archives instead of deleting, with optimistic concurrency', async () => {
    const owner = await signup('Owner');
    const biz = await createBusinessFor(owner);
    const p = { tenantSlug: biz.slug };
    const c = (await owner.call(customers.POST, { params: p, body: { display_name: 'Short-term' } })).body.data;
    const arch = await owner.call(customerOne.PATCH, { params: { ...p, id: c.id }, body: { version: 1, archived: true } });
    expect(arch.body.data.status).toBe('archived');
    expect((await owner.call(customerOne.PATCH, { params: { ...p, id: c.id }, body: { version: 1, display_name: 'stale' } })).status).toBe(409);
    expect((await owner.call(customers.GET, { params: p })).body.data.items).toHaveLength(0);
    expect((await owner.call(customers.GET, { params: p, query: { status: 'archived' } })).body.data.items).toHaveLength(1);
    expect((customerOne as Record<string, unknown>).DELETE).toBeUndefined(); // no delete endpoint exists
  });
});

describe('consents', () => {
  it('effective state is the latest row; unsubscribe link withdraws and suppresses without login', async () => {
    const owner = await signup('Owner');
    const biz = await createBusinessFor(owner);
    const customer = await signup('Customer');
    const tc = await relationshipFor(biz.tenantId, customer);
    const p = { tenantSlug: biz.slug, id: tc };
    const eff = () => withTenant(biz.tenantId, (trx) => effectiveConsent(trx, biz.tenantId, tc, 'email', 'marketing'));
    expect((await eff()).granted).toBe(false);
    await owner.call(customerConsents.POST, { params: p, body: { channel: 'email', granted: true } });
    expect((await eff()).granted).toBe(true);
    const rel = (await customer.call(accConsents.GET)).body.data[0];
    expect(rel.consents.marketing.email.granted).toBe(true);
    await customer.call(accConsents.PUT, { method: 'PUT', body: { tenant_customer_id: tc, channel: 'email', purpose: 'marketing', granted: false } });
    expect(await eff()).toMatchObject({ granted: false, source: 'account' });
    await customer.call(accConsents.PUT, { method: 'PUT', body: { tenant_customer_id: tc, channel: 'email', purpose: 'marketing', granted: true } });
    expect((await eff()).granted).toBe(true);
    // Customers cannot set consents on other people's relationships.
    const other = await signup('Other');
    expect((await other.call(accConsents.PUT, { method: 'PUT', body: { tenant_customer_id: tc, channel: 'email', purpose: 'marketing', granted: false } })).status).toBe(404);

    const url = unsubscribeUrl(biz.tenantId, tc);
    expect(url).toMatch(/^http:\/\/localhost:3000\/unsubscribe\?token=/);
    const token = createUnsubscribeToken(biz.tenantId, tc);
    const anon = new TestClient();
    const bad = await anon.call(unsubscribe.POST, { body: { token: `${token.slice(0, -3)}abc` } });
    expect(bad.status).toBe(422);
    const ok = await anon.call(unsubscribe.POST, { body: { token } });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ unsubscribed: true, channel: 'email' });
    expect(await eff()).toMatchObject({ granted: false, source: 'unsubscribe_link' });
    const email = (await me(customer)).email!;
    expect(await withTenant(biz.tenantId, (trx) => isSuppressed(trx, biz.tenantId, 'email', email))).toBe(true);
    expect((await anon.call(unsubscribe.POST, { body: { token } })).status).toBe(200); // idempotent
    // History is append-only.
    await expect(withTenant(biz.tenantId, (trx) => trx.deleteFrom('customer_consents').where('tenant_customer_id', '=', tc).execute())).rejects.toThrow();
  });
});

describe('reviews', () => {
  it('only her own completed booking, once; hidden reviews are not public', async () => {
    const owner = await signup('Owner');
    const biz = await createBusinessFor(owner);
    const customer = await signup('Reviewer customer');
    const cu = await me(customer);
    const tc = await relationshipFor(biz.tenantId, customer);
    const done = await insertBooking(biz.tenantId, biz.branchId, { tenantCustomerId: tc, customerUserId: cu.id, status: 'completed', startsAt: hoursAgo(30) });
    const upcoming = await insertBooking(biz.tenantId, biz.branchId, { tenantCustomerId: tc, customerUserId: cu.id, status: 'confirmed', startsAt: hoursFromNow(30) });
    const other = await signup('Someone else');

    const pending = await customer.call(accReviews.GET);
    expect(pending.body.data.pending.map((x: any) => x.id)).toEqual([done.id]);
    expect((await other.call(accReviews.POST, { body: { booking_id: done.id, rating: 1 } })).status).toBe(404);
    expect((await customer.call(accReviews.POST, { body: { booking_id: upcoming.id, rating: 5 } })).body.error.code).toBe('review_not_eligible');
    expect((await customer.call(accReviews.POST, { body: { booking_id: done.id, rating: 6 } })).status).toBe(422);
    const r = await customer.call(accReviews.POST, { body: { booking_id: done.id, rating: 5, comment: 'Lovely visit' } });
    expect(r.status).toBe(201);
    const again = await customer.call(accReviews.POST, { body: { booking_id: done.id, rating: 1 } });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('review_exists');

    const p = { tenantSlug: biz.slug };
    expect((await withTenant(biz.tenantId, (trx) => listPublishedReviews(trx, biz.tenantId)))).toHaveLength(1);
    const reply = await owner.call(reviewReply.POST, { params: { ...p, id: r.body.data.id }, body: { reply: 'Thank you!' } });
    expect(reply.body.data.business_reply).toBe('Thank you!');
    expect((await owner.call(reviewModerate.POST, { params: { ...p, id: r.body.data.id }, body: { status: 'hidden' } })).status).toBe(422);
    const hide = await owner.call(reviewModerate.POST, { params: { ...p, id: r.body.data.id }, body: { status: 'hidden', reason: 'Contains personal data' } });
    expect(hide.body.data.status).toBe('hidden');
    expect(await withTenant(biz.tenantId, (trx) => listPublishedReviews(trx, biz.tenantId))).toHaveLength(0);
    const list = await owner.call(reviews.GET, { params: p });
    expect(list.body.data.items).toHaveLength(1); // never deleted
    expect(list.body.data.stats.published).toBe(0);
    const mine = await customer.call(accReviews.GET);
    expect(mine.body.data.written[0]).toMatchObject({ is_public: false });
    expect(mine.body.data.written[0]).not.toHaveProperty('moderation_reason');
  });
});

describe('account profile', () => {
  it('updates display name, locale and time format for the signed-in user only', async () => {
    const c = await signup('Before');
    const r = await c.call(accProfile.PATCH, { method: 'PATCH', body: { display_name: 'After', locale: 'en', time_format: '24h' } });
    expect(r.body.data).toMatchObject({ display_name: 'After', locale: 'en', time_format: '24h' });
    expect((await c.call(accProfile.PATCH, { method: 'PATCH', body: { email: 'x@example.test' } })).status).toBe(422);
    expect((await new TestClient().call(accProfile.GET)).status).toBe(401);
  });
});
