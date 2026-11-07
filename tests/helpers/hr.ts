import { expect } from 'vitest';
import { DateTime } from 'luxon';
import { NextRequest } from 'next/server';
import { at, customer, futureDate, TZ, type Salon } from './salon';
import { signup } from './factory';
import type { TestClient } from './http';
import { withTenant } from '@/server/db/client';
import { resolveSession } from '@/server/auth/service';
import { resolveTenantAccess } from '@/server/tenancy/access';
import * as hold from '@/app/api/v1/s/[slug]/bookings/route';
import * as checkout from '@/app/api/v1/s/[slug]/bookings/[id]/checkout/route';
import * as invitations from '@/app/api/v1/t/[tenantSlug]/invitations/route';
import * as accept from '@/app/api/v1/invitations/accept/route';
import * as salary from '@/app/api/v1/t/[tenantSlug]/payroll/salaries/[staffId]/route';

export const now = () => DateTime.now().setZone(TZ);
export const today = () => now().toISODate()!;
export const dayOffset = (n: number) => now().plus({ days: n }).toISODate()!;
export const thisMonth = () => now().toFormat('yyyy-MM');

/** Invites and links a member with a role (optionally to a staff profile). */
export async function member(s: Salon, role: 'manager' | 'specialist' | 'receptionist' | 'finance', staffProfileId?: string, granted: string[] = []) {
  const m = await signup(role);
  const inv = await s.owner.call(invitations.POST, { params: { tenantSlug: s.slug }, body: { identifier: m.identifier, role, granted_capabilities: granted, ...(staffProfileId ? { staff_profile_id: staffProfileId } : {}) } });
  expect(inv.status).toBe(201);
  const token = inv.body.data.dev_invite_link.split('/invite/')[1];
  expect((await m.call(accept.POST, { body: { token } })).status).toBe(200);
  return m;
}

export async function setPay(s: Salon, staffId: string, base: number, hire: string | null) {
  const r = await s.owner.call(salary.PUT, { method: 'PUT', params: { tenantSlug: s.slug, staffId }, body: { base_salary_minor: base, employment_start: hire } });
  expect(r.status).toBe(200);
}

/** A confirmed booking (customer hold + pay on site). */
export async function book(s: Salon, serviceId: string, staffId: string, date: string, hhmm: string) {
  const c = await customer();
  const h = await c.call(hold.POST, { params: { slug: s.slug }, body: { items: [{ key: 'x', service_id: serviceId, staff_id: staffId, start: at(date, hhmm) }] }, idempotencyKey: true });
  if (h.status !== 201) throw new Error(JSON.stringify(h.body));
  const id = h.body.data.booking_id as string;
  const co = await c.call(checkout.POST, { params: { slug: s.slug, id }, body: { option: 'on_site' }, idempotencyKey: true });
  if (co.status >= 300) throw new Error(JSON.stringify(co.body));
  return { id, customer: c };
}

export async function userId(c: TestClient) {
  return (await resolveSession(c.cookies.get('luma_session')))!.userId;
}

export async function ownerAccess(s: Salon) {
  const user = await resolveSession(s.owner.cookies.get('luma_session'));
  return resolveTenantAccess(user!, s.slug);
}

/** Records a clock-in at a local date/time (attendance events are append-only). */
export async function clockInAt(s: Salon, staffId: string, date: string, hhmm: string) {
  await withTenant(s.tenantId, (trx) => trx.insertInto('attendance_events').values({
    tenant_id: s.tenantId, staff_id: staffId, kind: 'clock_in', at: DateTime.fromISO(`${date}T${hhmm}`, { zone: TZ }).toJSDate(), source: 'manager',
  }).execute());
}

/** Calls a route handler with multipart/form-data as the given client. */
export async function callForm(c: TestClient, handler: (req: NextRequest, seg: { params: Promise<Record<string, string>> }) => Promise<Response>, params: Record<string, string>, form: FormData) {
  const headers = new Headers({ 'x-luma-csrf': '1', 'x-forwarded-for': c.ip, cookie: [...c.cookies].map(([k, v]) => `${k}=${v}`).join('; ') });
  const req = new NextRequest(new URL('http://localhost:3000/api/test'), { method: 'POST', headers, body: form });
  const res = await handler(req, { params: Promise.resolve(params) });
  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

export { futureDate };
