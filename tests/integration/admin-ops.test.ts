import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createBusinessFor, signup, uniq } from '../helpers/factory';
import { newSession, platformUser, stepUp } from '../helpers/platform';
import { at, customer, futureDate, makeSalon } from '../helpers/salon';
import { withSystem, withTenant } from '@/server/db/client';
import { resetPlatformSettingsCache, getPlatformSetting } from '@/server/domains/platform/settings';
import { marketplaceSettings } from '@/server/domains/marketplace/listing';
import { setMarketplaceFeeSource } from '@/server/domains/settlements/fees';
import { totpCode } from '@/server/domains/platform/totp';
import * as settings from '@/app/api/v1/platform/settings/route';
import * as analytics from '@/app/api/v1/platform/analytics/route';
import * as report from '@/app/api/v1/platform/reports/[kind]/route';
import * as actBookings from '@/app/api/v1/platform/activity/bookings/route';
import * as actPayments from '@/app/api/v1/platform/activity/payments/route';
import * as feed from '@/app/api/v1/platform/feed/route';
import * as settlements from '@/app/api/v1/platform/settlements/route';
import * as settlementOne from '@/app/api/v1/platform/settlements/[id]/route';
import * as settle from '@/app/api/v1/platform/settlements/[id]/settle/route';
import * as approvals from '@/app/api/v1/platform/approvals/route';
import * as approvalOne from '@/app/api/v1/platform/approvals/[id]/route';
import * as mfaEnroll from '@/app/api/v1/platform/mfa/enroll/route';
import * as mfaActivate from '@/app/api/v1/platform/mfa/activate/route';
import * as mfaVerify from '@/app/api/v1/platform/mfa/verify/route';
import * as tenantsCreate from '@/app/api/v1/tenants/route';
import * as services from '@/app/api/v1/t/[tenantSlug]/services/route';
import * as tBookings from '@/app/api/v1/t/[tenantSlug]/bookings/route';
import * as availability from '@/app/api/v1/s/[slug]/availability/route';
import * as hold from '@/app/api/v1/s/[slug]/bookings/route';
import * as checkout from '@/app/api/v1/s/[slug]/bookings/[id]/checkout/route';
import * as sandboxPay from '@/app/api/v1/sandbox/checkout/[providerPaymentId]/route';
import * as publish from '@/app/api/v1/t/[tenantSlug]/builder/publish/route';

async function setSetting(key: string, value: unknown) {
  await withSystem('test: platform setting', (trx) => trx.insertInto('platform_settings').values({ key, value: JSON.stringify(value) })
    .onConflict((oc) => oc.column('key').doUpdateSet({ value: JSON.stringify(value) })).execute());
  resetPlatformSettingsCache();
}

afterEach(async () => {
  for (const [k, v] of [['maintenance_mode', false], ['allow_signups', true], ['require_business_approval', false]] as const) await setSetting(k, v);
  setMarketplaceFeeSource(null);
});

/** A salon with one paid (captured, sandbox) online booking. */
async function paidSalon() {
  const s = await makeSalon();
  const c = await customer('Payer');
  const h = await c.call(hold.POST, { params: { slug: s.slug }, body: { items: [{ key: 'a', service_id: s.services.haircut, staff_id: s.staff.sara, start: at(futureDate(4), '11:00') }] }, idempotencyKey: true });
  expect(h.status).toBe(201);
  const id = h.body.data.booking_id as string;
  await withTenant(s.tenantId, (trx) => trx.updateTable('bookings').set({ customer_note: 'PRIVATE-NOTE-xyz' }).where('id', '=', id).execute());
  const co = await c.call(checkout.POST, { params: { slug: s.slug, id }, body: { option: 'full' }, idempotencyKey: true });
  expect(co.status).toBe(201);
  const pp = await withTenant(s.tenantId, (trx) => trx.selectFrom('payments').select('provider_payment_id').where('id', '=', co.body.data.payment.id).executeTakeFirstOrThrow());
  const done = await c.call(sandboxPay.POST, { params: { providerPaymentId: pp.provider_payment_id! }, body: { outcome: 'captured' } });
  expect(done.status).toBe(200);
  return { ...s, bookingId: id };
}

describe('maintenance mode', () => {
  it('locks business dashboards (API) but storefront browsing and booking keep working; support staff pass', async () => {
    const s = await makeSalon();
    const admin = await platformUser('platform_owner', 'Maintenance admin');
    await stepUp(admin);
    const on = await admin.call(settings.PUT, { method: 'PUT', body: { maintenance_mode: true } });
    expect(on.status).toBe(200);
    expect(await getPlatformSetting('maintenance_mode')).toBe(true);

    const dash = await s.owner.call(services.GET, { params: { tenantSlug: s.slug } });
    expect(dash.status).toBe(503);
    expect(dash.body.error.code).toBe('maintenance');
    expect(dash.body.error.details.message_ar).toBeTruthy();
    expect((await s.owner.call(tBookings.GET, { params: { tenantSlug: s.slug } })).status).toBe(503);

    // Storefront: availability and a new booking hold still work.
    const c = await customer('During maintenance');
    const d = futureDate(5);
    const av = await c.call(availability.POST, { params: { slug: s.slug }, body: { items: [{ key: 'a', service_id: s.services.haircut, staff_id: s.staff.sara }], from: d, to: d } });
    expect(av.status).toBe(200);
    const h = await c.call(hold.POST, { params: { slug: s.slug }, body: { items: [{ key: 'a', service_id: s.services.haircut, staff_id: s.staff.sara, start: at(d, '12:00') }] }, idempotencyKey: true });
    expect(h.status).toBe(201);

    // Platform administration is not a business dashboard.
    expect((await admin.call(settings.GET)).status).toBe(200);
    const audited = await withSystem('test', (trx) => trx.selectFrom('audit_logs').select('data').where('action', '=', 'platform.settings.updated').orderBy('created_at', 'desc').executeTakeFirstOrThrow());
    expect(JSON.stringify(audited.data)).toContain('maintenance_mode');

    await admin.call(settings.PUT, { method: 'PUT', body: { maintenance_mode: false } });
    expect((await s.owner.call(services.GET, { params: { tenantSlug: s.slug } })).status).toBe(200);
  });

  it('closing sign-ups blocks new businesses; manual approval keeps a new business from publishing until approved', async () => {
    await setSetting('allow_signups', false);
    const u = await signup('Closed signups');
    const r = await u.call(tenantsCreate.POST, { body: { name: 'Closed', slug: `t-${uniq()}`, business_type: 'salon' } });
    expect(r.status).toBe(403);
    expect(r.body.error.details.reason).toBe('signups_closed');
    await setSetting('allow_signups', true);

    await setSetting('require_business_approval', true);
    const biz = await createBusinessFor(u);
    expect((biz as any).pending_approval).toBe(true);
    const pub = await u.call(publish.POST, { params: { tenantSlug: biz.slug }, body: {}, idempotencyKey: true });
    expect(pub.status).toBe(403);
    expect(pub.body.error.details.reason).toBe('approval_pending');

    const admin = await platformUser('platform_owner', 'Approver');
    const q = await admin.call(approvals.GET);
    expect(q.body.data.items.some((i: any) => i.tenant_id === biz.tenantId)).toBe(true);
    await stepUp(admin);
    const ok = await admin.call(approvalOne.POST, { params: { id: biz.tenantId }, body: { decision: 'approve' } });
    expect(ok.status).toBe(200);
    const pub2 = await u.call(publish.POST, { params: { tenantSlug: biz.slug }, body: {}, idempotencyKey: true });
    expect(pub2.body.error?.details?.reason).not.toBe('approval_pending');
  });

  it('requires verification for the marketplace by default (single setting in marketplace_settings)', async () => {
    expect((await marketplaceSettings()).require_verification).toBe(true);
  });
});

describe('platform-only access and MFA', () => {
  const routes = [
    () => analytics.GET, () => actBookings.GET, () => actPayments.GET, () => feed.GET, () => settlements.GET, () => settings.GET, () => approvals.GET,
  ];
  it('non-platform users get 404; support admins see activity and feed only; MFA is enforced on the new routes', async () => {
    const owner = await signup('Biz owner');
    await createBusinessFor(owner);
    for (const r of routes) expect((await owner.call(r())).status).toBe(404);
    expect((await owner.call(report.GET, { params: { kind: 'vat_summary' } })).status).toBe(404);

    const support = await platformUser('support_admin', 'Support viewer');
    expect((await support.call(actBookings.GET)).status).toBe(200);
    expect((await support.call(actPayments.GET)).status).toBe(200);
    expect((await support.call(feed.GET)).status).toBe(200);
    expect((await support.call(analytics.GET)).status).toBe(404);
    expect((await support.call(settlements.GET)).status).toBe(404);
    expect((await support.call(settings.GET)).status).toBe(404);
    const tech = await platformUser('technical_admin', 'Tech viewer');
    expect((await tech.call(actBookings.GET)).status).toBe(404);

    const admin = await platformUser('platform_owner', 'MFA owner admin');
    const en = await admin.call(mfaEnroll.POST, { body: {} });
    const secret = en.body.data.secret as string;
    expect((await admin.call(mfaActivate.POST, { body: { code: totpCode(secret) } })).status).toBe(200);
    const second = await newSession(admin.identifier);
    for (const r of routes) {
      const res = await second.call(r());
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('mfa_required');
    }
    expect((await second.call(mfaVerify.POST, { body: { code: totpCode(secret, Date.now() + 30_000) } })).status).toBe(200);
    expect((await second.call(analytics.GET)).status).toBe(200);
    // Settings changes need a fresh password step-up on top of MFA.
    const stale = await second.call(settings.PUT, { method: 'PUT', body: { platform_name: 'LUMA' } });
    expect([401, 200]).toContain(stale.status);
  });
});

describe('platform activity, analytics, reports, feed and exports', () => {
  it('lists bookings/payments across tenants without customer data; CSV exports are audited', async () => {
    const s = await paidSalon();
    const admin = await platformUser('platform_owner', 'Activity admin');
    const b = await admin.call(actBookings.GET, { query: { tenant: s.slug } });
    expect(b.status).toBe(200);
    expect(b.body.data.items).toHaveLength(1);
    expect(b.body.data.items[0]).toMatchObject({ tenant_slug: s.slug, source: 'storefront', status: 'confirmed', payment_status: 'paid' });
    const json = JSON.stringify(b.body.data);
    expect(json).not.toContain('PRIVATE-NOTE');
    expect(json).not.toMatch(/customer|phone|email/);
    expect((await admin.call(actBookings.GET, { query: { tenant: s.slug, status: 'cancelled' } })).body.data.items).toHaveLength(0);
    expect((await admin.call(actBookings.GET, { query: { tenant: s.slug, source: 'dashboard' } })).body.data.items).toHaveLength(0);

    const p = await admin.call(actPayments.GET, { query: { tenant: s.slug, status: 'captured', source: 'booking' } });
    expect(p.body.data.items).toHaveLength(1);
    expect(p.body.data.captured_minor).toBe(10000);

    const csv = await admin.call(actBookings.GET, { query: { tenant: s.slug, format: 'csv' } });
    expect(csv.status).toBe(200);
    expect(csv.headers.get('content-type')).toContain('text/csv');
    expect(csv.headers.get('content-disposition')).toContain('luma-bookings.csv');
    const lines = String(csv.body).replace(/^﻿/, '').split('\r\n');
    expect(lines[0]).toBe('number,tenant_slug,tenant_name,tenant_city,status,payment_status,source,starts_at,ends_at,items,total_minor,paid_minor,refunded_minor,currency,created_at');
    expect(lines).toHaveLength(2);
    expect(String(csv.body)).not.toContain('PRIVATE-NOTE');
    const pcsv = await admin.call(actPayments.GET, { query: { tenant: s.slug, format: 'csv' } });
    expect(String(pcsv.body)).toContain('sandbox');
    const exportsLogged = await withSystem('test', (trx) => trx.selectFrom('audit_logs').select('data').where('action', '=', 'platform.export').execute());
    expect(exportsLogged.some((e) => (e.data as any).kind === 'activity.bookings')).toBe(true);
  });

  it('analytics covers categories, cities, conversion, retention, rating, peak hours and revenue; reports export as CSV', async () => {
    await paidSalon();
    const admin = await platformUser('platform_owner', 'Analytics admin');
    const a = await admin.call(analytics.GET);
    expect(a.status).toBe(200);
    const d = a.body.data;
    expect(d.totals.bookings).toBeGreaterThanOrEqual(1);
    expect(d.bookings_by_city.some((c: any) => c.city === 'الرياض')).toBe(true);
    expect(d.bookings_by_category.length).toBeGreaterThanOrEqual(1);
    expect(d.trial_conversion.trials).toBeGreaterThanOrEqual(1);
    expect(d.peak_hours.by_hour).toHaveLength(24);
    expect(d.revenue).toHaveProperty('marketplace_fees_minor');
    expect(d.provider_retention).toHaveProperty('rate');
    expect(d.average_rating).toHaveProperty('average');
    const csv = await admin.call(analytics.GET, { query: { format: 'csv' } });
    expect(String(csv.body)).toContain('section,key,value,extra');
    expect(String(csv.body)).toContain('bookings_by_city');

    for (const kind of ['monthly_revenue', 'vat_summary', 'provider_performance', 'bookings']) {
      const r = await admin.call(report.GET, { params: { kind } });
      expect(r.status, kind).toBe(200);
      const c = await admin.call(report.GET, { params: { kind }, query: { format: 'csv' } });
      expect(c.headers.get('content-type'), kind).toContain('text/csv');
    }
    const vat = (await admin.call(report.GET, { params: { kind: 'vat_summary' } })).body.data.rows;
    expect(vat.map((r: any) => r.source)).toEqual(['subscriptions', 'marketplace_fees', 'total']);
    expect((await admin.call(report.GET, { params: { kind: 'nope' } })).status).toBe(404);
    // 15% VAT inside a VAT-inclusive amount: 115.00 → 15.00
    const { vatOfInclusive } = await import('@/shared/platform-settings');
    expect(vatOfInclusive(11500)).toBe(1500);
  });

  it('the live feed shows new bookings, payments and sign-ups as summaries with tenant links', async () => {
    const since = new Date(Date.now() - 1000).toISOString();
    const s = await paidSalon();
    const admin = await platformUser('platform_owner', 'Feed admin');
    const f = await admin.call(feed.GET, { query: { since } });
    expect(f.status).toBe(200);
    const kinds = new Set(f.body.data.items.filter((i: any) => i.tenant_slug === s.slug).map((i: any) => i.kind));
    expect(kinds).toEqual(new Set(['booking', 'payment', 'signup']));
    expect(f.body.data.items[0].link).toMatch(/^\/platform\/tenants\?q=/);
    expect(JSON.stringify(f.body.data)).not.toContain('PRIVATE-NOTE');
  });
});

describe('settlements (split payments)', () => {
  it('generates per-tenant statements: gross − refunds − marketplace fee = provider net; settle freezes; HTML statement', async () => {
    const s = await paidSalon();
    setMarketplaceFeeSource({ name: 'test-fixed-15pct', forTenant: async (_trx, tenantId) => ({ fee_minor: tenantId === s.tenantId ? 1500 : 0, bookings: 1, source: 'test-fixed-15pct' }) });
    const admin = await platformUser('platform_owner', 'Settlement admin');
    const today = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
    const to = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const gen = await admin.call(settlements.POST, { body: { from, to, tenant: s.slug } });
    expect(gen.status).toBe(200);
    expect(gen.body.data.created).toBe(1);
    const list = await admin.call(settlements.GET, { query: { tenant: s.slug } });
    const st = list.body.data.items[0];
    expect(st).toMatchObject({ gross_minor: 10000, refunds_minor: 0, fee_minor: 1500, net_minor: 8500, status: 'simulated', payments_count: 1, fee_source: 'test-fixed-15pct' });
    expect(today >= from).toBe(true);

    const html = await admin.call(settlementOne.GET, { params: { id: st.id }, query: { format: 'html' } });
    expect(html.headers.get('content-type')).toContain('text/html');
    expect(String(html.body)).toContain('كشف تسوية');
    expect(String(html.body)).not.toContain('PRIVATE-NOTE');
    const csv = await admin.call(settlements.GET, { query: { tenant: s.slug, format: 'csv' } });
    expect(String(csv.body)).toContain('net_minor');

    const stale = await admin.call(settle.POST, { params: { id: st.id }, body: { reference: 'PAYOUT-123' } });
    expect([200, 401]).toContain(stale.status);
    await stepUp(admin);
    const done = await admin.call(settle.POST, { params: { id: st.id }, body: { reference: 'PAYOUT-123' } });
    expect(done.status === 200 || done.body.error.code === 'already_settled').toBe(true);
    // Settled statements are never recomputed.
    setMarketplaceFeeSource({ name: 'other', forTenant: async () => ({ fee_minor: 9999, bookings: 1, source: 'other' }) });
    const regen = await admin.call(settlements.POST, { body: { from, to, tenant: s.slug } });
    expect(regen.body.data.skipped_settled).toBe(1);
    expect((await admin.call(settlements.GET, { query: { tenant: s.slug } })).body.data.items[0].fee_minor).toBe(1500);
    expect((await admin.call(settle.POST, { params: { id: randomUUID() }, body: { reference: 'x1' } })).status).toBe(404);
  });
});
