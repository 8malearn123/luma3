import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { createBusinessFor, signup } from '../helpers/factory';
import { TestClient } from '../helpers/http';
import { expireStepUp, grantRole, newSession, platformUser, stepUp, userIdOf } from '../helpers/platform';
import { db, withSystem } from '@/server/db/client';
import { totpCode } from '@/server/domains/platform/totp';
import { listApprovedTemplates } from '@/server/domains/platform/templates';
import * as register from '@/app/api/v1/auth/register/route';
import * as verify from '@/app/api/v1/auth/verify/route';
import * as me from '@/app/api/v1/platform/me/route';
import * as tenantsList from '@/app/api/v1/platform/tenants/route';
import * as tenantOne from '@/app/api/v1/platform/tenants/[id]/route';
import * as plans from '@/app/api/v1/platform/plans/route';
import * as planOne from '@/app/api/v1/platform/plans/[id]/route';
import * as revenue from '@/app/api/v1/platform/revenue/route';
import * as roles from '@/app/api/v1/platform/users/[id]/roles/route';
import * as mfaReset from '@/app/api/v1/platform/users/[id]/mfa-reset/route';
import * as mfaEnroll from '@/app/api/v1/platform/mfa/enroll/route';
import * as mfaActivate from '@/app/api/v1/platform/mfa/activate/route';
import * as mfaVerify from '@/app/api/v1/platform/mfa/verify/route';
import * as overview from '@/app/api/v1/platform/overview/route';
import * as integrations from '@/app/api/v1/platform/integrations/route';
import * as audit from '@/app/api/v1/platform/audit/route';
import * as templates from '@/app/api/v1/platform/templates/route';
import * as templateStatus from '@/app/api/v1/platform/templates/[id]/status/route';
import * as members from '@/app/api/v1/t/[tenantSlug]/members/route';
import * as services from '@/app/api/v1/t/[tenantSlug]/services/route';
import * as supportGrants from '@/app/api/v1/platform/support-grants/route';
import * as userStatus from '@/app/api/v1/platform/users/[id]/status/route';
import { maintainUsageCounters } from '@/server/domains/subscriptions/service';
import { resetEnvCache } from '@/server/env';

const PLATFORM_DIR = path.resolve(import.meta.dirname, '../../src/app/api/v1/platform');

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? routeFiles(p) : f === 'route.ts' ? [p] : [];
  });
}

describe('platform endpoints are invisible to non-platform users', () => {
  it('every /api/v1/platform handler returns 404 to a tenant owner and to a plain customer', async () => {
    const owner = await signup('Salon owner');
    await createBusinessFor(owner);
    const customer = await signup('Customer');
    const files = routeFiles(PLATFORM_DIR);
    expect(files.length).toBeGreaterThan(25);
    let checked = 0;
    for (const file of files) {
      const mod = await import(file);
      for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const) {
        const h = mod[method];
        if (!h) continue;
        for (const c of [owner, customer]) {
          const r = await c.call(h, { method, params: { id: randomUUID(), type: 'hero' }, body: method === 'GET' ? undefined : {} });
          expect(r.status, `${method} ${path.relative(PLATFORM_DIR, file)}`).toBe(404);
        }
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(30);
    // Anonymous callers are asked to sign in (no information about the route's purpose).
    expect((await new TestClient().call(overview.GET)).status).toBe(401);
  });

  it('nobody can self-grant a platform role via registration or tenant APIs', async () => {
    const c = new TestClient();
    const identifier = `selfgrant-${randomUUID().slice(0, 8)}@example.test`;
    const r = await c.call(register.POST, { body: { identifier, password: 'correct horse battery', display_name: 'Sneaky', platform_roles: ['platform_owner'], role: 'platform_owner' } });
    expect(r.status).toBe(202);
    await c.call(verify.POST, { body: { identifier, code: r.body.data.delivery.dev_code } });
    expect((await c.call(me.GET)).status).toBe(404);
    const biz = await createBusinessFor(c as never);
    const inv = await c.call(members.GET, { params: { tenantSlug: biz.slug } });
    expect(inv.status).toBe(200);
    const id = await userIdOf(identifier);
    const rows = await db().selectFrom('platform_roles').select('id').where('user_id', '=', id).execute();
    expect(rows).toHaveLength(0);
  });
});

describe('least privilege between platform roles', () => {
  it('support admin cannot edit plans or grant roles; policy reviewer cannot view revenue', async () => {
    const support = await platformUser('support_admin');
    const reviewer = await platformUser('policy_reviewer');
    const tech = await platformUser('technical_admin');
    const plan = (await support.call(plans.GET)).body.data[0];
    expect(plan.code).toBeTruthy();

    const edit = await support.call(planOne.PUT, { params: { id: plan.id }, body: { version: plan.version, trial_days: 30 } });
    expect(edit.status).toBe(404);
    const target = await signup('Target');
    const targetId = await userIdOf(target.identifier);
    expect((await support.call(roles.POST, { params: { id: targetId }, body: { role: 'support_admin', action: 'grant', reason: 'should not be allowed' } })).status).toBe(404);
    expect((await reviewer.call(revenue.GET)).status).toBe(404);
    expect((await reviewer.call(tenantsList.GET)).status).toBe(200);
    expect((await tech.call(integrations.GET)).status).toBe(200);
    expect((await tech.call(revenue.GET)).status).toBe(404);
    expect((await support.call(audit.GET)).status).toBe(200);
  });

  it('role grants need platform_owner + fresh step-up, are audited, and the last owner cannot be removed', async () => {
    const owner = await platformUser('platform_owner');
    const target = await signup('New support');
    const targetId = await userIdOf(target.identifier);
    await expireStepUp(owner.identifier);
    const stale = await owner.call(roles.POST, { params: { id: targetId }, body: { role: 'support_admin', action: 'grant', reason: 'joining the support team' } });
    expect(stale.status).toBe(401);
    expect(stale.body.error.code).toBe('reauthentication_required');
    await stepUp(owner);
    const ok = await owner.call(roles.POST, { params: { id: targetId }, body: { role: 'support_admin', action: 'grant', reason: 'joining the support team' } });
    expect(ok.status).toBe(200);
    expect(ok.body.data.roles).toEqual(['support_admin']);
    expect((await target.call(me.GET)).status).toBe(200);
    const logged = await withSystem('test', (trx) => trx.selectFrom('audit_logs').selectAll().where('action', '=', 'platform.role.granted').where('target_id', '=', targetId).execute());
    expect(logged).toHaveLength(1);
    expect(logged[0]!.actor_kind).toBe('platform');

    // Revoking every platform owner is refused (others may exist from other tests; revoke them until one remains).
    const owners = await db().selectFrom('platform_roles').select('user_id').where('role', '=', 'platform_owner').where('revoked_at', 'is', null).execute();
    const ownerId = await userIdOf(owner.identifier);
    for (const o of owners.filter((x) => x.user_id !== ownerId)) {
      const r = await owner.call(roles.POST, { params: { id: o.user_id }, body: { role: 'platform_owner', action: 'revoke', reason: 'test cleanup of owners' } });
      expect(r.status).toBe(200);
    }
    const last = await owner.call(roles.POST, { params: { id: ownerId }, body: { role: 'platform_owner', action: 'revoke', reason: 'trying to remove myself' } });
    expect(last.status).toBe(409);
    expect(last.body.error.code).toBe('last_platform_owner');
  });

  it('the bootstrap CLI logic grants roles with a system audit record', async () => {
    const u = await signup('Bootstrapped');
    const r = await grantRole(u.identifier, 'technical_admin');
    expect(r.changed).toBe(true);
    const again = await grantRole(u.identifier, 'technical_admin');
    expect(again.changed).toBe(false);
    const a = await withSystem('test', (trx) => trx.selectFrom('audit_logs').selectAll().where('action', '=', 'platform.role.granted').where('target_id', '=', r.userId).executeTakeFirstOrThrow());
    expect(a.actor_kind).toBe('system');
    await grantRole(u.identifier, 'technical_admin', true);
    expect((await u.call(me.GET)).status).toBe(404);
  });
});

describe('admin MFA (TOTP)', () => {
  it('when MFA is required (always in production), staff without MFA can only enrol', async () => {
    process.env.PLATFORM_MFA_REQUIRED = 'true';
    resetEnvCache();
    try {
      const admin = await platformUser('platform_owner', 'Must enrol');
      const blocked = await admin.call(overview.GET);
      expect(blocked.status).toBe(403);
      expect(blocked.body.error.code).toBe('mfa_enrollment_required');
      const en = await admin.call(mfaEnroll.POST, { body: {} });
      expect(en.status).toBe(200);
      expect((await admin.call(mfaActivate.POST, { body: { code: totpCode(en.body.data.secret) } })).status).toBe(200);
      expect((await admin.call(overview.GET)).status).toBe(200);
    } finally {
      delete process.env.PLATFORM_MFA_REQUIRED;
      resetEnvCache();
    }
  });

  it('enrols, rejects wrong codes, stores the secret encrypted, and requires per-session verification', async () => {
    const admin = await platformUser('platform_owner', 'MFA owner');
    const en = await admin.call(mfaEnroll.POST, { body: {} });
    expect(en.status).toBe(200);
    const secret: string = en.body.data.secret;
    expect(en.body.data.otpauth_uri).toContain('otpauth://totp/');

    const wrong = await admin.call(mfaActivate.POST, { body: { code: totpCode(secret) === '000000' ? '111111' : '000000' } });
    expect(wrong.status).toBe(422);
    expect(wrong.body.error.code).toBe('mfa_code_invalid');
    const act = await admin.call(mfaActivate.POST, { body: { code: totpCode(secret) } });
    expect(act.status).toBe(200);

    const id = await userIdOf(admin.identifier);
    const row = await db().selectFrom('users').select(['mfa_totp_secret_enc', 'mfa_enabled_at']).where('id', '=', id).executeTakeFirstOrThrow();
    expect(row.mfa_enabled_at).not.toBeNull();
    expect(row.mfa_totp_secret_enc).toMatch(/^v1\./);
    expect(row.mfa_totp_secret_enc).not.toContain(secret);

    // The enrolling session was verified during activation.
    expect((await admin.call(tenantsList.GET)).status).toBe(200);

    // A new session must pass the second factor before any platform route works.
    const second = await newSession(admin.identifier);
    const blocked = await second.call(tenantsList.GET);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('mfa_required');
    expect((await second.call(me.GET)).status).toBe(200); // the MFA prompt itself stays reachable
    expect((await second.call(mfaVerify.POST, { body: { code: '123456' === totpCode(secret, Date.now() + 30_000) ? '654321' : '123456' } })).status).toBe(422);
    const ok = await second.call(mfaVerify.POST, { body: { code: totpCode(secret, Date.now() + 30_000) } });
    expect(ok.status).toBe(200);
    expect((await second.call(tenantsList.GET)).status).toBe(200);
    // The same code cannot be replayed in a third session.
    const third = await newSession(admin.identifier);
    expect((await third.call(mfaVerify.POST, { body: { code: totpCode(secret, Date.now() + 30_000) } })).status).toBe(422);
  });

  it('the platform owner can reset another admin\'s MFA (step-up, audited)', async () => {
    const owner = await platformUser('platform_owner', 'Resetter');
    const admin = await platformUser('support_admin', 'Lost phone');
    const en = await admin.call(mfaEnroll.POST, { body: {} });
    await admin.call(mfaActivate.POST, { body: { code: totpCode(en.body.data.secret) } });
    const adminId = await userIdOf(admin.identifier);
    const r = await owner.call(mfaReset.POST, { params: { id: adminId }, body: { reason: 'lost authenticator device' } });
    expect(r.status).toBe(200);
    const row = await db().selectFrom('users').select(['mfa_enabled_at', 'mfa_totp_secret_enc']).where('id', '=', adminId).executeTakeFirstOrThrow();
    expect(row.mfa_enabled_at).toBeNull();
    expect(row.mfa_totp_secret_enc).toBeNull();
    const fresh = await newSession(admin.identifier);
    expect((await fresh.call(tenantsList.GET)).status).toBe(200);
    const a = await withSystem('test', (trx) => trx.selectFrom('audit_logs').select('id').where('action', '=', 'platform.mfa.reset').where('target_id', '=', adminId).execute());
    expect(a).toHaveLength(1);
  });
});

describe('platform views of businesses', () => {
  it('lists businesses with allowlisted fields and aggregate counts only', async () => {
    const owner = await signup('Listed owner');
    const biz = await createBusinessFor(owner, { name: 'Listed Salon' });
    const admin = await platformUser('support_admin');
    const list = await admin.call(tenantsList.GET, { query: { q: biz.slug } });
    expect(list.status).toBe(200);
    expect(list.body.data.items[0]).toMatchObject({ slug: biz.slug, sub_status: 'trialing', plan_code: 'sanaa' });
    const d = await admin.call(tenantOne.GET, { params: { id: biz.tenantId } });
    expect(d.status).toBe(200);
    expect(d.body.data.counts).toHaveProperty('customers');
    expect(JSON.stringify(d.body.data)).not.toContain('tenant_customers');
  });
});

describe('templates', () => {
  it('rejects invalid block JSON and exposes only approved templates to businesses', async () => {
    const owner = await platformUser('platform_owner', 'Template owner');
    const bad = await owner.call(templates.POST, { body: {
      key: `bad-${randomUUID().slice(0, 6)}`, name_ar: 'قالب', name_en: 'Bad', business_types: ['salon'],
      document: { layout: {}, pages: [{ kind: 'home', blocks: [{ id: 'b_aaaaaa', type: 'hero', schemaVersion: 1, props: { overlay: 9 }, visibility: { enabled: true }, children: [] }] }] },
    } });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('invalid_template');
    const scripty = await owner.call(templates.POST, { body: {
      key: `bad2-${randomUUID().slice(0, 6)}`, name_ar: 'قالب', name_en: 'Bad', business_types: ['salon'],
      document: { layout: {}, pages: [{ kind: 'home', blocks: [{ id: 'b_bbbbbb', type: 'script', schemaVersion: 1, props: {}, visibility: { enabled: true } }] }] },
    } });
    expect(scripty.status).toBe(422);

    const key = `elegant-${randomUUID().slice(0, 6)}`;
    const good = await owner.call(templates.POST, { body: {
      key, name_ar: 'أنيق', name_en: 'Elegant', business_types: ['salon', 'spa'],
      document: { layout: { nav_style: 'pill' }, pages: [{ kind: 'home', blocks: [
        { id: 'b_hero01', type: 'hero', schemaVersion: 1, props: { title: { ar: 'مرحباً', en: 'Welcome' } }, visibility: { enabled: true }, action: { type: 'start_booking' } },
        { id: 'b_text01', type: 'text', schemaVersion: 1, props: { content: { ar: [{ t: 'p', c: [{ text: 'نص' }] }] } }, visibility: { enabled: true } },
      ] }] },
    } });
    expect(good.status).toBe(201);
    expect(good.body.data.status).toBe('draft');
    expect((await listApprovedTemplates('salon')).some((t) => t.key === key)).toBe(false);
    const ap = await owner.call(templateStatus.POST, { params: { id: good.body.data.id }, body: { status: 'approved', version: good.body.data.version } });
    expect(ap.status).toBe(200);
    expect((await listApprovedTemplates('salon')).some((t) => t.key === key)).toBe(true);
    expect((await listApprovedTemplates('expert')).some((t) => t.key === key)).toBe(false);
    const rt = await owner.call(templateStatus.POST, { params: { id: good.body.data.id }, body: { status: 'retired', version: ap.body.data.version } });
    expect(rt.status).toBe(200);
    expect((await listApprovedTemplates('salon')).some((t) => t.key === key)).toBe(false);
  });
});

describe('support access respects admin MFA, account suspension, usage counters', () => {
  it('a support grant is unusable from a session that has not passed MFA', async () => {
    const owner = await signup('MFA-supported owner');
    const biz = await createBusinessFor(owner);
    const support = await platformUser('support_admin', 'MFA support');
    const en = await support.call(mfaEnroll.POST, { body: {} });
    await support.call(mfaActivate.POST, { body: { code: totpCode(en.body.data.secret) } });
    const g = await support.call(supportGrants.POST, { body: { tenant_slug: biz.slug, reason: 'owner asked for help with setup', hours: 1 } });
    expect(g.status).toBe(201);
    expect((await support.call(services.GET, { params: { tenantSlug: biz.slug } })).status).toBe(200);
    const other = await newSession(support.identifier);
    expect((await other.call(services.GET, { params: { tenantSlug: biz.slug } })).status).toBe(404);
    await other.call(mfaVerify.POST, { body: { code: totpCode(en.body.data.secret, Date.now() + 30_000) } });
    expect((await other.call(services.GET, { params: { tenantSlug: biz.slug } })).status).toBe(200);
  });

  it('suspending an account signs it out and ends its support access; reactivation restores sign-in', async () => {
    const owner = await platformUser('platform_owner', 'Account admin');
    const target = await platformUser('support_admin', 'To suspend');
    const targetId = await userIdOf(target.identifier);
    expect((await owner.call(userStatus.POST, { params: { id: await userIdOf(owner.identifier) }, body: { status: 'suspended', reason: 'cannot suspend myself' } })).status).toBe(422);
    const s = await owner.call(userStatus.POST, { params: { id: targetId }, body: { status: 'suspended', reason: 'compromised account report' } });
    expect(s.status).toBe(200);
    expect((await target.call(me.GET)).status).toBe(401);
    const r = await owner.call(userStatus.POST, { params: { id: targetId }, body: { status: 'active', reason: 'identity re-verified' } });
    expect(r.status).toBe(200);
    expect((await (await newSession(target.identifier)).call(me.GET)).status).toBe(200);
  });

  it('usage counter maintenance snapshots monthly usage per business', async () => {
    const owner = await signup('Counted');
    const biz = await createBusinessFor(owner);
    await owner.call(services.POST, { params: { tenantSlug: biz.slug }, body: { name_ar: 'خدمة', price_minor: 1000, duration_min: 30 } });
    await maintainUsageCounters();
    const rows = await withSystem('test', (trx) => trx.selectFrom('usage_counters').selectAll().where('tenant_id', '=', biz.tenantId).execute());
    expect(rows.find((r) => r.metric === 'limit.services')?.value).toBe(1);
    expect(rows.find((r) => r.metric === 'limit.branches')?.value).toBe(1);
  });
});
