import { TestClient } from './http';
import * as register from '@/app/api/v1/auth/register/route';
import * as verify from '@/app/api/v1/auth/verify/route';
import * as tenants from '@/app/api/v1/tenants/route';

export const uniq = () => Math.random().toString(36).slice(2, 10);

/** Registers and verifies a user through the real API; returns a signed-in client. */
export async function signup(name = 'Test User', opts: { phone?: boolean } = {}) {
  const c = new TestClient();
  const identifier = opts.phone ? `+9665${Math.floor(10000000 + Math.random() * 89999999)}` : `u-${uniq()}@example.test`;
  const r = await c.call(register.POST, { body: { identifier, password: 'correct horse battery', display_name: name } });
  if (r.status !== 202) throw new Error(`register failed: ${JSON.stringify(r.body)}`);
  const v = await c.call(verify.POST, { body: { identifier, code: r.body.data.delivery.dev_code } });
  if (v.status !== 200) throw new Error(`verify failed: ${JSON.stringify(v.body)}`);
  return Object.assign(c, { identifier });
}

export async function createBusinessFor(c: TestClient, overrides: Record<string, unknown> = {}) {
  const slug = `t-${uniq()}`;
  const r = await c.call(tenants.POST, { body: { name: 'صالون تجريبي', slug, business_type: 'salon', city: 'الرياض', ...overrides } });
  if (r.status !== 201) throw new Error(`create business failed: ${JSON.stringify(r.body)}`);
  return { slug: (overrides.slug as string) ?? slug, ...r.body.data } as { slug: string; tenantId: string; branchId: string; staffProfileId: string | null };
}
