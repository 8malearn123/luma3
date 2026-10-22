import pg from 'pg';
import { signup } from './factory';
import { TestClient } from './http';
import { db, withSystem } from '@/server/db/client';
import { bootstrapPlatformRole, type BootstrapRole } from '@/server/domains/platform/bootstrap';
import * as login from '@/app/api/v1/auth/login/route';
import * as reauth from '@/app/api/v1/auth/reauth/route';
import * as invitations from '@/app/api/v1/t/[tenantSlug]/invitations/route';
import * as accept from '@/app/api/v1/invitations/accept/route';

export const PASSWORD = 'correct horse battery';

/** Grants a platform role through the bootstrap path (the CLI's logic, owner connection). */
export async function grantRole(identifier: string, role: BootstrapRole, revoke = false) {
  const client = new pg.Client({ connectionString: process.env.DATABASE_OWNER_URL });
  await client.connect();
  try {
    return await bootstrapPlatformRole(client, identifier.includes('@') ? { email: identifier, role, revoke } : { phone: identifier, role, revoke });
  } finally {
    await client.end();
  }
}

export async function platformUser(role: BootstrapRole, name = `Admin ${role}`) {
  const c = await signup(name);
  await grantRole(c.identifier, role);
  return c;
}

export async function userIdOf(identifier: string) {
  const u = await db().selectFrom('users').select('id').where(identifier.includes('@') ? 'email' : 'phone', '=', identifier).executeTakeFirstOrThrow();
  return u.id;
}

/** Makes the client's step-up stale (as if the password was confirmed long ago). */
export async function expireStepUp(identifier: string) {
  const id = await userIdOf(identifier);
  await db().updateTable('sessions').set({ reauthenticated_at: new Date(Date.now() - 3_600_000) }).where('user_id', '=', id).execute();
}

export async function stepUp(c: TestClient) {
  const r = await c.call(reauth.POST, { body: { password: PASSWORD } });
  if (r.status !== 200) throw new Error(`reauth failed: ${JSON.stringify(r.body)}`);
}

/** A second, fresh session for the same account. */
export async function newSession(identifier: string) {
  const c = new TestClient();
  const r = await c.call(login.POST, { body: { identifier, password: PASSWORD } });
  if (r.status !== 200) throw new Error(`login failed: ${JSON.stringify(r.body)}`);
  return Object.assign(c, { identifier });
}

export async function addMember(owner: TestClient, slug: string, role: 'manager' | 'receptionist' | 'specialist' | 'finance', granted: string[] = []) {
  const m = await signup(`Member ${role}`);
  const inv = await owner.call(invitations.POST, { params: { tenantSlug: slug }, body: { identifier: m.identifier, role, granted_capabilities: granted } });
  if (inv.status !== 201) throw new Error(`invite failed: ${JSON.stringify(inv.body)}`);
  const token = inv.body.data.dev_invite_link.split('/invite/')[1];
  const acc = await m.call(accept.POST, { body: { token } });
  if (acc.status !== 200) throw new Error(`accept failed: ${JSON.stringify(acc.body)}`);
  return m;
}

export async function setSubscription(tenantId: string, patch: Record<string, unknown>) {
  await withSystem('test: adjust subscription', (trx) => trx.updateTable('subscriptions').set(patch).where('tenant_id', '=', tenantId).execute());
}

export async function subscriptionOf(tenantId: string) {
  return withSystem('test: read subscription', (trx) => trx.selectFrom('subscriptions').selectAll().where('tenant_id', '=', tenantId).orderBy('created_at', 'desc').executeTakeFirstOrThrow());
}
