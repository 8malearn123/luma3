import { describe, expect, it } from 'vitest';
import { createBusinessFor, signup } from '../helpers/factory';
import { addMember, expireStepUp, platformUser, stepUp } from '../helpers/platform';
import { withSystem } from '@/server/db/client';
import * as services from '@/app/api/v1/t/[tenantSlug]/services/route';
import * as settings from '@/app/api/v1/t/[tenantSlug]/settings/route';
import * as profile from '@/app/api/v1/t/[tenantSlug]/settings/profile/route';
import * as policy from '@/app/api/v1/t/[tenantSlug]/settings/booking-policy/route';
import * as confirm from '@/app/api/v1/t/[tenantSlug]/settings/booking-policy/confirm/route';
import * as legal from '@/app/api/v1/t/[tenantSlug]/settings/legal-tax/route';
import * as notifications from '@/app/api/v1/t/[tenantSlug]/settings/notifications/route';
import * as branches from '@/app/api/v1/t/[tenantSlug]/branches/route';
import * as branchOne from '@/app/api/v1/t/[tenantSlug]/branches/[id]/route';
import * as readiness from '@/app/api/v1/t/[tenantSlug]/onboarding/readiness/route';
import * as tenantAudit from '@/app/api/v1/t/[tenantSlug]/audit/route';
import * as grants from '@/app/api/v1/platform/support-grants/route';
import * as revoke from '@/app/api/v1/platform/support-grants/[id]/revoke/route';

const basePolicy = {
  slot_increment_min: 15, min_notice_min: 120, max_advance_days: 45, hold_ttl_sec: 600, no_show_grace_min: 15, max_gap_between_items_min: 20,
  any_staff_rule: 'earliest_then_staff_order', free_cancellation_hours: 12, late_cancellation_fee_bp: 2500, deposit_mode: 'percent', deposit_percent_bp: 2000,
  deposit_fixed_minor: 0, allow_full_prepay: true, allow_pay_on_site: true, booking_requires_account: true,
  booking_policy_text_ar: 'يمكن الإلغاء مجاناً قبل ١٢ ساعة.', booking_policy_text_en: 'Free cancellation up to 12 hours before.',
};

describe('tenant settings', () => {
  it('versioned writes (409 on stale), validation of timezone/phone/social, and policy confirmation flips readiness', async () => {
    const owner = await signup('Settings owner');
    const biz = await createBusinessFor(owner);
    const p = { tenantSlug: biz.slug };
    const s = await owner.call(settings.GET, { params: p });
    expect(s.status).toBe(200);
    const v1 = s.body.data.settings.version;
    expect(s.body.data.channel_status.email).toBe('dev_simulation');

    const ok = await owner.call(profile.PUT, { params: p, body: { version: v1, name: 'صالون لوما', city: 'جدة', default_locale: 'ar', timezone: 'Asia/Riyadh', contact_phone: '0551234567', social_links: { instagram: '@luma.salon' } } });
    expect(ok.status).toBe(200);
    const stale = await owner.call(profile.PUT, { params: p, body: { version: v1, name: 'Overwrite', default_locale: 'en', timezone: 'Asia/Riyadh' } });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('version_conflict');
    const v2 = ok.body.data.version;
    const after = await owner.call(settings.GET, { params: p });
    expect(after.body.data.tenant.name).toBe('صالون لوما');
    expect(after.body.data.settings.contact_phone).toBe('+966551234567');
    expect(after.body.data.settings.social_links).toEqual({ instagram: 'luma.salon' });

    expect((await owner.call(profile.PUT, { params: p, body: { version: v2, name: 'X', default_locale: 'ar', timezone: 'Mars/Olympus' } })).status).toBe(422);
    expect((await owner.call(profile.PUT, { params: p, body: { version: v2, name: 'X', default_locale: 'ar', timezone: 'Asia/Riyadh', contact_phone: '12' } })).status).toBe(422);
    expect((await owner.call(profile.PUT, { params: p, body: { version: v2, name: 'X', default_locale: 'ar', timezone: 'Asia/Riyadh', social_links: { instagram: 'https://evil.example/x' } } })).status).toBe(422);
    expect((await owner.call(legal.PUT, { params: p, body: { version: v2, tax_rate_bp: 20000, prices_include_tax: true } })).status).toBe(422);

    let rd = await owner.call(readiness.GET, { params: p });
    expect(rd.body.data.items.find((i: any) => i.key === 'booking_policy').ok).toBe(false);
    const pol = await owner.call(policy.PUT, { params: p, body: { version: v2, ...basePolicy } });
    expect(pol.status).toBe(200);
    const cf = await owner.call(confirm.POST, { params: p, body: { version: pol.body.data.version, confirmed: true } });
    expect(cf.status).toBe(200);
    rd = await owner.call(readiness.GET, { params: p });
    expect(rd.body.data.items.find((i: any) => i.key === 'booking_policy').ok).toBe(true);
    // Changing the terms asks for a fresh review.
    const pol2 = await owner.call(policy.PUT, { params: p, body: { version: cf.body.data.version, ...basePolicy, free_cancellation_hours: 24 } });
    expect(pol2.body.data.confirmation_cleared).toBe(true);
    rd = await owner.call(readiness.GET, { params: p });
    expect(rd.body.data.items.find((i: any) => i.key === 'booking_policy').ok).toBe(false);

    const bad = await owner.call(policy.PUT, { params: p, body: { version: pol2.body.data.version, ...basePolicy, deposit_mode: 'fixed', deposit_fixed_minor: 0 } });
    expect(bad.status).toBe(422);
    const n = await owner.call(notifications.PUT, { params: p, body: { version: pol2.body.data.version, notify_channels: ['email'] } });
    expect(n.body.data.notify_channels).toEqual(['in_app', 'email']);
  });

  it('a manager without business.manage gets 403 on settings and branches', async () => {
    const owner = await signup('Owner M');
    const biz = await createBusinessFor(owner);
    const manager = await addMember(owner, biz.slug, 'manager');
    const p = { tenantSlug: biz.slug };
    expect((await manager.call(settings.GET, { params: p })).status).toBe(403);
    expect((await manager.call(profile.PUT, { params: p, body: { version: 1, name: 'Hijack', default_locale: 'ar', timezone: 'Asia/Riyadh' } })).status).toBe(403);
    expect((await manager.call(branches.POST, { params: p, body: { name: 'B', timezone: 'Asia/Riyadh' } })).status).toBe(403);
    expect((await manager.call(branches.GET, { params: p })).status).toBe(200); // managers can see branches for scheduling
  });

  it('branches: weekly hours with multiple ranges, overlap rejected, primary cannot be archived, version conflicts', async () => {
    const owner = await signup('Branch owner');
    const biz = await createBusinessFor(owner, { plan_code: 'fareed' });
    const p = { tenantSlug: biz.slug };
    const overlap = await owner.call(branches.POST, { params: p, body: { name: 'O', timezone: 'Asia/Riyadh', hours: [{ weekday: 1, opens: '10:00', closes: '15:00' }, { weekday: 1, opens: '14:00', closes: '20:00' }] } });
    expect(overlap.status).toBe(422);
    expect(overlap.body.error.code).toBe('overlapping_hours');
    const b = await owner.call(branches.POST, { params: p, body: { name: 'Mall', timezone: 'Asia/Dubai', phone: '0559876543', hours: [{ weekday: 1, opens: '10:00', closes: '13:00' }, { weekday: 1, opens: '16:00', closes: '23:00' }] } });
    expect(b.status).toBe(201);
    const list = await owner.call(branches.GET, { params: p });
    const mall = list.body.data.items.find((x: any) => x.id === b.body.data.id);
    expect(mall.hours).toEqual([{ weekday: 1, opens: '10:00', closes: '13:00' }, { weekday: 1, opens: '16:00', closes: '23:00' }]);
    const primary = list.body.data.items.find((x: any) => x.is_primary);
    expect((await owner.call(branchOne.PATCH, { params: { ...p, id: primary.id }, body: { version: primary.version, status: 'archived' } })).status).toBe(422);
    const sw = await owner.call(branchOne.PATCH, { params: { ...p, id: mall.id }, body: { version: mall.version, is_primary: true } });
    expect(sw.status).toBe(200);
    expect((await owner.call(branchOne.PATCH, { params: { ...p, id: mall.id }, body: { version: mall.version, name: 'stale' } })).status).toBe(409);
    const ar = await owner.call(branchOne.PATCH, { params: { ...p, id: primary.id }, body: { version: primary.version, status: 'archived' } });
    expect(ar.status).toBe(200);
  });
});

describe('support access', () => {
  it('no grant → 404; read grant reads but cannot mutate; write grant actions audited with grant id; revoked/expired → 404', async () => {
    const owner = await signup('Supported owner');
    const biz = await createBusinessFor(owner);
    const p = { tenantSlug: biz.slug };
    await owner.call(services.POST, { params: p, body: { name_ar: 'خدمة', price_minor: 1000, duration_min: 30 } });
    const support = await platformUser('support_admin', 'Support agent');

    expect((await support.call(services.GET, { params: p })).status).toBe(404);
    expect((await support.call(grants.POST, { body: { tenant_slug: biz.slug, reason: 'short', hours: 2 } })).status).toBe(422);
    expect((await support.call(grants.POST, { body: { tenant_slug: biz.slug, reason: 'owner asked for help with services', hours: 48 } })).status).toBe(422);
    await expireStepUp(support.identifier);
    expect((await support.call(grants.POST, { body: { tenant_slug: biz.slug, reason: 'owner asked for help with services', hours: 2 } })).status).toBe(401);
    await stepUp(support);

    const g = await support.call(grants.POST, { body: { tenant_slug: biz.slug, reason: 'owner asked for help with services', hours: 2, access_level: 'read' } });
    expect(g.status).toBe(201);
    expect(g.body.data.open_path).toBe(`/app/${biz.slug}`);
    const read = await support.call(services.GET, { params: p });
    expect(read.status).toBe(200);
    expect(read.body.data).toHaveLength(1);
    const mutate = await support.call(services.POST, { params: p, body: { name_ar: 'x', price_minor: 1, duration_min: 30 } });
    expect(mutate.status).toBe(403);
    expect((await support.call(settings.GET, { params: p })).status).toBe(403); // owner-only settings stay closed

    const rv = await support.call(revoke.POST, { params: { id: g.body.data.id }, body: { reason: 'done' } });
    expect(rv.status).toBe(200);
    expect((await support.call(services.GET, { params: p })).status).toBe(404);

    const w = await support.call(grants.POST, { body: { tenant_slug: biz.slug, reason: 'fix catalog entries for the owner', hours: 1, access_level: 'write' } });
    expect(w.status).toBe(201);
    const created = await support.call(services.POST, { params: p, body: { name_ar: 'أضافها الدعم', price_minor: 2000, duration_min: 30 } });
    expect(created.status).toBe(201);
    const a = await withSystem('test', (trx) => trx.selectFrom('audit_logs').selectAll().where('tenant_id', '=', biz.tenantId).where('action', '=', 'service.created').where('support_grant_id', '=', w.body.data.id).execute());
    expect(a).toHaveLength(1);
    expect(a[0]!.actor_kind).toBe('support');

    // Owner sees support actions highlighted in her own audit log, and was notified.
    const log = await owner.call(tenantAudit.GET, { params: p, query: { support_only: '1' } });
    expect(log.status).toBe(200);
    expect(log.body.data.items.length).toBeGreaterThanOrEqual(3);
    expect(log.body.data.items.every((i: any) => i.is_support)).toBe(true);

    // Expired grant → 404 again.
    await withSystem('test: expire grant', (trx) => trx.updateTable('support_access_grants').set({ starts_at: new Date(Date.now() - 7_200_000), expires_at: new Date(Date.now() - 3_600_000) }).where('id', '=', w.body.data.id).execute());
    expect((await support.call(services.GET, { params: p })).status).toBe(404);

    // The 24h ceiling is a database invariant too.
    await expect(withSystem('test', (trx) => trx.insertInto('support_access_grants').values({ tenant_id: biz.tenantId, platform_user_id: a[0]!.actor_user_id!, reason: 'longer than allowed window', expires_at: new Date(Date.now() + 25 * 3_600_000), created_by: a[0]!.actor_user_id! }).execute())).rejects.toThrow();
  });

  it('tenant audit log is paginated and filterable', async () => {
    const owner = await signup('Audit owner');
    const biz = await createBusinessFor(owner);
    const p = { tenantSlug: biz.slug };
    for (let i = 0; i < 4; i++) await owner.call(services.POST, { params: p, body: { name_ar: `s${i}`, price_minor: 100, duration_min: 30 } });
    const page1 = await owner.call(tenantAudit.GET, { params: p, query: { limit: '2', action: 'service.' } });
    expect(page1.body.data.items).toHaveLength(2);
    expect(page1.body.data.next_cursor).toBeTruthy();
    const page2 = await owner.call(tenantAudit.GET, { params: p, query: { limit: '2', action: 'service.', cursor: page1.body.data.next_cursor } });
    expect(page2.body.data.items).toHaveLength(2);
    expect(page2.body.data.items[0].id).not.toBe(page1.body.data.items[0].id);
    const recep = await addMember(owner, biz.slug, 'receptionist');
    expect((await recep.call(tenantAudit.GET, { params: p })).status).toBe(403);
  });
});
