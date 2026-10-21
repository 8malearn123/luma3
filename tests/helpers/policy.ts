import { randomUUID } from 'node:crypto';
import { db, withTenant } from '@/server/db/client';
import { ensureTenantCustomerForUser } from '@/server/domains/customers/relationship';
import * as session from '@/app/api/v1/auth/session/route';
import * as invitations from '@/app/api/v1/t/[tenantSlug]/invitations/route';
import * as accept from '@/app/api/v1/invitations/accept/route';
import type { TestClient } from './http';
import { signup } from './factory';

export async function me(c: TestClient): Promise<{ id: string; display_name: string; email: string | null; phone: string | null }> {
  const r = await c.call(session.GET);
  return r.body.data.user;
}

/** Invites a fresh user into the business with a role (+ delegated capabilities) and returns her client. */
export async function addMember(owner: TestClient, slug: string, role: 'manager' | 'receptionist' | 'specialist' | 'finance', granted: string[] = [], name = role) {
  const m = await signup(name);
  const inv = await owner.call(invitations.POST, { params: { tenantSlug: slug }, body: { identifier: m.identifier, role, granted_capabilities: granted } });
  if (inv.status !== 201) throw new Error(`invite failed: ${JSON.stringify(inv.body)}`);
  const token = inv.body.data.dev_invite_link.split('/invite/')[1];
  const acc = await m.call(accept.POST, { body: { token } });
  if (acc.status !== 200) throw new Error(`accept failed: ${JSON.stringify(acc.body)}`);
  return m;
}

/** The customer's relationship row at a business (as storefront booking would create it). */
export async function relationshipFor(tenantId: string, customer: TestClient) {
  const u = await me(customer);
  return withTenant(tenantId, (trx) => ensureTenantCustomerForUser(trx, tenantId, { userId: u.id, displayName: u.display_name, phone: u.phone, email: u.email }));
}

/** Inserts a booking directly (the booking flow is built elsewhere). */
export async function insertBooking(tenantId: string, branchId: string, opts: {
  tenantCustomerId: string; customerUserId?: string | null; status: string; startsAt: Date; durationMin?: number; totalMinor?: number;
  cancelSource?: 'customer' | 'business' | 'system'; cancelledAt?: Date;
}) {
  return withTenant(tenantId, async (trx) => {
    const ends = new Date(opts.startsAt.getTime() + (opts.durationMin ?? 60) * 60_000);
    const row = await trx.insertInto('bookings').values({
      tenant_id: tenantId, branch_id: branchId, number: `T-${randomUUID().slice(0, 8)}`, tenant_customer_id: opts.tenantCustomerId,
      customer_user_id: opts.customerUserId ?? null, status: opts.status, source: 'dashboard', starts_at: opts.startsAt, ends_at: ends,
      timezone: 'Asia/Riyadh', subtotal_minor: opts.totalMinor ?? 10000, total_minor: opts.totalMinor ?? 10000,
      cancel_source: opts.cancelSource ?? null, cancelled_at: opts.cancelledAt ?? null,
    }).returning(['id', 'number']).executeTakeFirstOrThrow();
    return row;
  });
}

export async function grantPlatformRole(userId: string, role: 'platform_owner' | 'policy_reviewer' | 'support_admin' | 'technical_admin') {
  await db().insertInto('platform_roles').values({ user_id: userId, role }).execute();
}

/** Makes every session of the user "not recently re-authenticated". */
export async function expireStepUp(userId: string) {
  await db().updateTable('sessions').set({ reauthenticated_at: new Date(Date.now() - 3_600_000) }).where('user_id', '=', userId).execute();
}

export async function setTenantSettings(tenantId: string, patch: Record<string, unknown>) {
  await withTenant(tenantId, (trx) => trx.updateTable('tenant_settings').set(patch).where('tenant_id', '=', tenantId).execute());
}

export const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);
export const hoursFromNow = (h: number) => new Date(Date.now() + h * 3_600_000);
