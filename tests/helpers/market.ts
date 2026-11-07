import { NextRequest } from 'next/server';
import { withTenant } from '@/server/db/client';
import { makeSalon, type Salon } from './salon';
import type { TestClient } from './http';
import { platformUser, stepUp } from './platform';
import * as docs from '@/app/api/v1/t/[tenantSlug]/marketplace/verification/documents/route';
import * as submit from '@/app/api/v1/t/[tenantSlug]/marketplace/verification/submit/route';
import * as request from '@/app/api/v1/t/[tenantSlug]/marketplace/request/route';
import * as reviewVerification from '@/app/api/v1/platform/marketplace/verifications/[tenantId]/review/route';
import * as reviewListing from '@/app/api/v1/platform/marketplace/listings/[tenantId]/review/route';
import * as commission from '@/app/api/v1/platform/marketplace/tenants/[tenantId]/commission/route';

export const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');
export const VALID_IBAN = 'SA0380000000608010167519';

/** Calls a multipart handler with the client's cookies (TestClient only sends JSON). */
export async function upload(c: TestClient, handler: (req: NextRequest, seg: { params: Promise<Record<string, string>> }) => Promise<Response>, params: Record<string, string>, fields: Record<string, string | Blob>) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  const headers = new Headers({ 'x-luma-csrf': '1', 'x-forwarded-for': c.ip });
  if (c.cookies.size) headers.set('cookie', [...c.cookies].map(([k, v]) => `${k}=${v}`).join('; '));
  const res = await handler(new NextRequest('http://localhost:3000/api/test', { method: 'POST', headers, body: form }), { params: Promise.resolve(params) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

export async function uploadDoc(owner: TestClient, slug: string, kind: string, extra: Record<string, string> = {}) {
  return upload(owner, docs.POST, { tenantSlug: slug }, { kind, file: new Blob([PDF], { type: 'application/pdf' }), ...extra });
}

export async function publish(s: { tenantId: string }) {
  await withTenant(s.tenantId, async (trx) => {
    const owner = await trx.selectFrom('tenant_memberships').select('user_id').where('role', '=', 'owner').executeTakeFirstOrThrow();
    const v = await trx.insertInto('site_versions').values({ tenant_id: s.tenantId, version_number: 1, snapshot: '{}', schema_version: 1, published_by: owner.user_id }).returning('id').executeTakeFirstOrThrow();
    await trx.updateTable('tenants').set({ published_version_id: v.id, status: 'active' }).where('id', '=', s.tenantId).execute();
  });
}

let admin: (TestClient & { identifier: string }) | null = null;
export async function marketAdmin() {
  if (!admin) admin = await platformUser('platform_owner', 'Market Admin');
  return admin;
}

/** Uploads every required document (by type) and submits for verification. */
export async function submitDocs(owner: TestClient, slug: string, type: string) {
  for (const k of [type === 'expert' ? 'freelance_document' : 'commercial_register', 'owner_id']) {
    const r = await uploadDoc(owner, slug, k);
    if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  }
  const ib = await uploadDoc(owner, slug, 'iban', { iban: VALID_IBAN });
  if (ib.status !== 201) throw new Error(JSON.stringify(ib.body));
  const sub = await owner.call(submit.POST, { params: { tenantSlug: slug }, body: {} });
  if (sub.status !== 200) throw new Error(JSON.stringify(sub.body));
}

/** A published salon, verified and approved in the marketplace. */
export async function listedBusiness(opts: { type?: 'salon' | 'expert' | 'spa' | 'beauty_center'; city?: string; name?: string; commissionBp?: number; lat?: number; lng?: number } = {}): Promise<Salon> {
  const s = await makeSalon();
  await withTenant(s.tenantId, async (trx) => {
    await trx.updateTable('tenants').set({ business_type: opts.type ?? 'salon', ...(opts.name ? { name: opts.name } : {}), ...(opts.city ? { city: opts.city } : {}) }).where('id', '=', s.tenantId).execute();
    await trx.updateTable('branches').set({ city: opts.city ?? 'الرياض', latitude: opts.lat ?? null, longitude: opts.lng ?? null }).where('id', '=', s.branchId).execute();
  });
  await publish(s);
  await submitDocs(s.owner, s.slug, opts.type ?? 'salon');
  const a = await marketAdmin();
  const v = await a.call(reviewVerification.POST, { params: { tenantId: s.tenantId }, body: { decision: 'approve' } });
  if (v.status !== 200) throw new Error(JSON.stringify(v.body));
  const r = await s.owner.call(request.POST, { params: { tenantSlug: s.slug }, body: {} });
  if (r.status !== 200) throw new Error(JSON.stringify(r.body));
  const ap = await a.call(reviewListing.POST, { params: { tenantId: s.tenantId }, body: { decision: 'approve' } });
  if (ap.status !== 200) throw new Error(JSON.stringify(ap.body));
  if (opts.commissionBp !== undefined) {
    await stepUp(a);
    const c = await a.call(commission.PUT, { params: { tenantId: s.tenantId }, body: { commission_bp: opts.commissionBp }, method: 'PUT' });
    if (c.status !== 200) throw new Error(JSON.stringify(c.body));
  }
  return s;
}
