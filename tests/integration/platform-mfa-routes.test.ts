import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestClient } from '../helpers/http';
import { createBusinessFor, signup } from '../helpers/factory';
import { platformUser } from '../helpers/platform';
import { resetEnvCache } from '@/server/env';

/**
 * LUMA-AUDIT-002 regression: EVERY route module under /api/v1/platform is
 * called for real (no source grepping) with
 *  - no session                               → 401,
 *  - a business owner (no platform role)      → 404 (existence hidden),
 *  - a platform owner whose session has not passed the second factor
 *    while MFA is required (as on every deployed build) → 403 mfa_required,
 * for every HTTP method the module exports. Only the MFA enrolment /
 * verification endpoints and /me are exempt from the MFA check.
 */
type Handler = (req: never, seg: never) => Promise<Response>;
const modules = import.meta.glob('/src/app/api/v1/platform/**/route.ts', { eager: true }) as Record<string, Record<string, unknown>>;
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
const MFA_EXEMPT = new Set(['me', 'mfa', 'mfa/verify', 'mfa/activate', 'mfa/send', 'mfa/enroll']);

type Case = { path: string; method: (typeof METHODS)[number]; handler: Handler; params: Record<string, string> };
const cases: Case[] = [];
for (const [file, mod] of Object.entries(modules)) {
  const path = file.replace(/^.*\/api\/v1\/platform\/?/, '').replace(/\/?route\.ts$/, '');
  // Dynamic segments get a well-formed id (UUID) or a plausible value for non-id segments.
  const params: Record<string, string> = {};
  for (const m of path.matchAll(/\[([^\]]+)\]/g)) params[m[1]!] = m[1] === 'kind' ? 'tenants' : m[1] === 'op' ? 'test' : m[1] === 'type' ? 'hero' : randomUUID();
  for (const method of METHODS) {
    if (typeof mod[method] === 'function') cases.push({ path, method, handler: mod[method] as Handler, params });
  }
}

const call = (c: TestClient, k: Case) => c.call(k.handler as never, {
  method: k.method, params: k.params, path: `/api/v1/platform/${k.path}`, ...(k.method === 'GET' ? {} : { body: {} }),
});

describe('every platform route enforces sign-in, the platform role and MFA (real requests)', () => {
  let anon: TestClient;
  let tenantOwner: TestClient;
  let admin: TestClient;

  beforeAll(async () => {
    process.env.PLATFORM_MFA_REQUIRED = 'true';
    resetEnvCache();
    anon = new TestClient();
    tenantOwner = await signup('Tenant owner');
    await createBusinessFor(tenantOwner);
    admin = await platformUser('platform_owner', 'Unverified platform owner');
  });
  afterAll(() => { delete process.env.PLATFORM_MFA_REQUIRED; resetEnvCache(); });

  it('discovers the platform route modules (including the eight policy routes)', () => {
    expect(cases.length).toBeGreaterThan(100);
    for (const p of ['policies/rules', 'policies/rules/[id]', 'policies/appeals', 'policies/appeals/[id]/resolve', 'policies/decisions',
      'policies/decisions/[id]/end', 'policies/escalations', 'policies/escalations/[id]/dismiss']) {
      expect(cases.some((k) => k.path === p), p).toBe(true);
    }
  });

  it.each(cases.map((k) => [`${k.method} /platform/${k.path}`, k] as const))('%s', async (_name, k) => {
    const a = await call(anon, k);
    expect(a.status, 'no session').toBe(401);

    const t = await call(tenantOwner, k);
    expect(t.status, 'tenant user').toBe(404);

    const p = await call(admin, k);
    if (MFA_EXEMPT.has(k.path)) {
      expect(p.body?.error?.code, 'exempt endpoint').not.toBe('mfa_required');
    } else {
      expect(p.status, `platform owner without MFA: ${JSON.stringify(p.body)}`).toBe(403);
      expect(p.body.error.code).toBe('mfa_required');
    }
  });
});
