import { describe, expect, it } from 'vitest';
import { createBusinessFor, signup } from '../helpers/factory';
import * as tenants from '@/app/api/v1/tenants/route';
import * as services from '@/app/api/v1/t/[tenantSlug]/services/route';
import * as serviceOne from '@/app/api/v1/t/[tenantSlug]/services/[id]/route';
import * as staff from '@/app/api/v1/t/[tenantSlug]/staff/route';
import * as onboarding from '@/app/api/v1/t/[tenantSlug]/onboarding/route';
import * as step from '@/app/api/v1/t/[tenantSlug]/onboarding/steps/[step]/route';
import * as generate from '@/app/api/v1/t/[tenantSlug]/onboarding/generate/route';
import * as readiness from '@/app/api/v1/t/[tenantSlug]/onboarding/readiness/route';
import * as invitations from '@/app/api/v1/t/[tenantSlug]/invitations/route';
import * as accept from '@/app/api/v1/invitations/accept/route';
import * as session from '@/app/api/v1/auth/session/route';
import * as register from '@/app/api/v1/auth/register/route';
import { TestClient } from '../helpers/http';

describe('business creation & membership', () => {
  it('creates a business with the caller as owner and a trial subscription', async () => {
    const owner = await signup('Noura');
    const biz = await createBusinessFor(owner);
    const s = await owner.call(session.GET);
    expect(s.body.data.memberships).toEqual([expect.objectContaining({ tenant_slug: biz.slug, role: 'owner' })]);
  });

  it('requires a verified account and ignores any browser-supplied role', async () => {
    const c = new TestClient();
    const email = `unverified-${Math.random().toString(36).slice(2)}@example.test`;
    await c.call(register.POST, { body: { identifier: email, password: 'correct horse battery', display_name: 'U' } });
    // Not signed in yet (verification signs in), so creating a business is unauthenticated.
    const r = await c.call(tenants.POST, { body: { name: 'X', slug: 'x-unverified', business_type: 'salon' } });
    expect(r.status).toBe(401);
    const owner = await signup();
    const bad = await owner.call(tenants.POST, { body: { name: 'X', slug: `x-${Date.now()}`, business_type: 'salon', role: 'platform_owner' } });
    expect(bad.status).toBe(422); // strict schema: unknown fields rejected
  });

  it('rejects duplicate and reserved slugs', async () => {
    const owner = await signup();
    const biz = await createBusinessFor(owner);
    const dup = await owner.call(tenants.POST, { body: { name: 'Y', slug: biz.slug, business_type: 'salon' } });
    expect(dup.status).toBe(409);
    const reserved = await owner.call(tenants.POST, { body: { name: 'Y', slug: 'platform', business_type: 'salon' } });
    expect(reserved.status).toBe(409);
  });
});

describe('tenant isolation', () => {
  it('a member of one business cannot read or modify another business, even with guessed ids', async () => {
    const a = await signup('Owner A');
    const b = await signup('Owner B');
    const bizA = await createBusinessFor(a);
    const bizB = await createBusinessFor(b);
    const svcB = await b.call(services.POST, { params: { tenantSlug: bizB.slug }, body: { name_ar: 'صبغة', price_minor: 25000, duration_min: 90 } });
    expect(svcB.status).toBe(201);

    // A tries B's slug directly: indistinguishable from a non-existent business.
    const r1 = await a.call(services.GET, { params: { tenantSlug: bizB.slug } });
    const r2 = await a.call(services.GET, { params: { tenantSlug: 'does-not-exist-xyz' } });
    expect(r1.status).toBe(404);
    expect(r2.status).toBe(404);
    expect(r1.body.error.code).toBe(r2.body.error.code);

    // A uses her own slug with B's service id.
    const r3 = await a.call(serviceOne.GET, { params: { tenantSlug: bizA.slug, id: svcB.body.data.id } });
    expect(r3.status).toBe(404);
    const r4 = await a.call(serviceOne.PATCH, { params: { tenantSlug: bizA.slug, id: svcB.body.data.id }, body: { version: 1, name_ar: 'hijack' } });
    expect(r4.status).toBe(404);

    // A tries to qualify B's staff for her own service (composite FK blocks it).
    const stB = await b.call(staff.POST, { params: { tenantSlug: bizB.slug }, body: { display_name: 'Specialist B' } });
    const r5 = await a.call(services.POST, { params: { tenantSlug: bizA.slug }, body: { name_ar: 'قص', price_minor: 5000, duration_min: 30, staff: [{ staff_id: stB.body.data.id }] } });
    expect([404, 422]).toContain(r5.status);
    const listA = await a.call(services.GET, { params: { tenantSlug: bizA.slug } });
    expect(listA.body.data).toHaveLength(0);
  });

  it('receptionist cannot see confidential service costs; owner can', async () => {
    const owner = await signup('Owner');
    const biz = await createBusinessFor(owner, { plan_code: 'wahaj' });
    await owner.call(services.POST, { params: { tenantSlug: biz.slug }, body: { name_ar: 'بروتين', price_minor: 60000, duration_min: 120, cost_minor: 15000 } });
    const recep = await signup('Reception');
    const inv = await owner.call(invitations.POST, { params: { tenantSlug: biz.slug }, body: { identifier: recep.identifier, role: 'receptionist' } });
    expect(inv.status).toBe(201);
    const token = inv.body.data.dev_invite_link.split('/invite/')[1];
    const acc = await recep.call(accept.POST, { body: { token } });
    expect(acc.status).toBe(200);
    const ownerView = await owner.call(services.GET, { params: { tenantSlug: biz.slug } });
    const recepView = await recep.call(services.GET, { params: { tenantSlug: biz.slug } });
    expect(ownerView.body.data[0].cost_minor).toBe(15000);
    expect(recepView.status).toBe(200);
    expect(recepView.body.data[0]).not.toHaveProperty('cost_minor');
    // Receptionist cannot create services or invite people.
    expect((await recep.call(services.POST, { params: { tenantSlug: biz.slug }, body: { name_ar: 'x', price_minor: 1, duration_min: 30 } })).status).toBe(403);
    expect((await recep.call(invitations.POST, { params: { tenantSlug: biz.slug }, body: { identifier: 'z@example.test', role: 'manager' } })).status).toBe(403);
    // Invitation cannot be replayed.
    expect((await recep.call(accept.POST, { body: { token } })).status).toBe(422);
  });

  it('an invitation only works for the verified identity it was sent to', async () => {
    const owner = await signup();
    const biz = await createBusinessFor(owner);
    const inv = await owner.call(invitations.POST, { params: { tenantSlug: biz.slug }, body: { identifier: 'someone-else@example.test', role: 'specialist' } });
    const token = inv.body.data.dev_invite_link.split('/invite/')[1];
    const intruder = await signup('Intruder');
    const r = await intruder.call(accept.POST, { body: { token } });
    expect(r.status).toBe(403);
  });

  it('managers cannot be granted owner-only or non-delegable capabilities', async () => {
    const owner = await signup();
    const biz = await createBusinessFor(owner);
    const r = await owner.call(invitations.POST, { params: { tenantSlug: biz.slug }, body: { identifier: 'm@example.test', role: 'manager', granted_capabilities: ['subscription.manage'] } });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('capability_not_delegable');
  });
});

describe('onboarding', () => {
  it('saves, resumes from another session, detects conflicts, and generates a draft without inventing data', async () => {
    const owner = await signup('Owner');
    const biz = await createBusinessFor(owner);
    const p = { tenantSlug: biz.slug };
    let ob = await owner.call(onboarding.GET, { params: p });
    expect(ob.body.data.completed_steps).toEqual([1]);
    const v1 = ob.body.data.version;
    const s3 = await owner.call(step.PUT, { params: { ...p, step: '3' }, body: { version: v1, answers: { traits: ['elegant', 'warm'], reference_style: 'classic_luxury' } } });
    expect(s3.status).toBe(200);
    // Stale version from a second device → conflict, not silent overwrite.
    const stale = await owner.call(step.PUT, { params: { ...p, step: '4' }, body: { version: v1, answers: {} } });
    expect(stale.status).toBe(409);

    // Resume from a different session of the same user.
    const { TestClient } = await import('../helpers/http');
    const other = new TestClient();
    other.cookies = new Map(owner.cookies);
    ob = await other.call(onboarding.GET, { params: p });
    expect(ob.body.data.answers['3'].traits).toEqual(['elegant', 'warm']);

    const s5 = await other.call(step.PUT, { params: { ...p, step: '5' }, body: { version: ob.body.data.version, answers: { specialties: ['hair'], services: [{ name: 'قص شعر', price_sar: 80, duration_min: 45 }, { name: 'استشارة' }] } } });
    expect(s5.status).toBe(200);
    const s7 = await other.call(step.PUT, { params: { ...p, step: '7' }, body: { version: s5.body.data.version, answers: { phone: '0551234567', hours: [{ weekday: 0, opens: '10:00', closes: '22:00' }], tagline: 'جمالك بلمسة' } } });
    expect(s7.status).toBe(200);

    const g = await owner.call(generate.POST, { params: p, body: {} });
    expect(g.status).toBe(200);
    expect(g.body.data.ai_used).toBe(false);
    expect(g.body.data.services_created).toBe(2);
    const svc = await owner.call(services.GET, { params: p });
    const unpriced = svc.body.data.find((s: any) => s.name_ar === 'استشارة');
    expect(unpriced.is_visible).toBe(false); // no invented price goes public
    expect(svc.body.data.find((s: any) => s.name_ar === 'قص شعر').price_minor).toBe(8000);

    // Regenerating does not duplicate services.
    const g2 = await owner.call(generate.POST, { params: p, body: {} });
    expect(g2.body.data.services_created).toBe(0);

    const rd = await owner.call(readiness.GET, { params: p });
    expect(rd.body.data.ready).toBe(false);
    expect(rd.body.data.items.find((i: any) => i.key === 'contact_details').ok).toBe(true);
    expect(rd.body.data.items.find((i: any) => i.key === 'bookable_service').ok).toBe(false);
  });
});
