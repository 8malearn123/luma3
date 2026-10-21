import { randomUUID } from 'node:crypto';
import { withTenant } from '@/server/db/client';

/**
 * Direct SQL fixtures for analytics/marketing tests. Bookings, orders and
 * reviews are owned by other domains (implemented concurrently), so tests
 * insert them inside withTenant instead of going through those APIs.
 */
type Biz = { tenantId: string; branchId: string };
let seq = 0;

export async function addStaff(biz: Biz, name = 'Specialist', opts: { userId?: string } = {}) {
  return withTenant(biz.tenantId, async (trx) => {
    const s = await trx.insertInto('staff_profiles').values({ tenant_id: biz.tenantId, display_name: name }).returning('id').executeTakeFirstOrThrow();
    if (opts.userId) {
      await trx.updateTable('tenant_memberships').set({ staff_profile_id: s.id }).where('user_id', '=', opts.userId).execute();
    }
    return s.id;
  });
}

export async function addService(biz: Biz, opts: { name?: string; price?: number; cost?: number | null; duration?: number; categoryId?: string | null } = {}) {
  return withTenant(biz.tenantId, async (trx) => {
    const s = await trx.insertInto('services').values({
      tenant_id: biz.tenantId, name_ar: opts.name ?? 'خدمة', name_en: opts.name ?? 'Service', price_minor: opts.price ?? 10000,
      cost_minor: opts.cost === undefined ? null : opts.cost, duration_min: opts.duration ?? 60, category_id: opts.categoryId ?? null,
    }).returning('id').executeTakeFirstOrThrow();
    return s.id;
  });
}

export async function addCategory(biz: Biz, name: string) {
  return withTenant(biz.tenantId, async (trx) => (await trx.insertInto('categories').values({ tenant_id: biz.tenantId, kind: 'service', name_en: name, name_ar: name, slug: `c-${++seq}-${Date.now() % 100000}` }).returning('id').executeTakeFirstOrThrow()).id);
}

export async function addCustomer(biz: Biz, opts: { name?: string; phone?: string | null; email?: string | null; userId?: string | null; tags?: string[] } = {}) {
  return withTenant(biz.tenantId, async (trx) => (await trx.insertInto('tenant_customers').values({
    tenant_id: biz.tenantId, display_name: opts.name ?? `Customer ${++seq}`, phone: opts.phone ?? null, email: opts.email ?? null,
    user_id: opts.userId ?? null, tags: opts.tags ?? [],
  }).returning('id').executeTakeFirstOrThrow()).id);
}

export async function addConsent(biz: Biz, customerId: string, channel: 'email' | 'sms' | 'whatsapp' | 'push', granted: boolean, at = new Date()) {
  await withTenant(biz.tenantId, (trx) => trx.insertInto('customer_consents').values({
    tenant_id: biz.tenantId, tenant_customer_id: customerId, channel, purpose: 'marketing', granted, source: 'dashboard', recorded_at: at,
  }).execute());
}

export async function addBooking(biz: Biz, opts: {
  customerId: string; serviceId: string; staffId: string; startsAt: Date; durationMin?: number; status?: string; price?: number;
  actualStart?: Date | null; actualEnd?: Date | null; campaignId?: string | null; refunded?: number;
}) {
  const dur = opts.durationMin ?? 60;
  const ends = new Date(opts.startsAt.getTime() + dur * 60_000);
  const price = opts.price ?? 10000;
  return withTenant(biz.tenantId, async (trx) => {
    const b = await trx.insertInto('bookings').values({
      tenant_id: biz.tenantId, branch_id: biz.branchId, number: `T-${randomUUID().slice(0, 12)}`, tenant_customer_id: opts.customerId,
      status: opts.status ?? 'completed', source: 'storefront', starts_at: opts.startsAt, ends_at: ends, timezone: 'Asia/Riyadh',
      subtotal_minor: price, total_minor: price, paid_minor: opts.refunded ? price : 0, refunded_minor: opts.refunded ?? 0, campaign_id: opts.campaignId ?? null,
    }).returning('id').executeTakeFirstOrThrow();
    await trx.insertInto('booking_items').values({
      tenant_id: biz.tenantId, booking_id: b.id, sequence: 1, service_id: opts.serviceId, staff_id: opts.staffId, starts_at: opts.startsAt, ends_at: ends,
      staff_name: 'S', duration_min: dur, unit_price_minor: price, line_total_minor: price,
      actual_started_at: opts.actualStart ?? null, actual_ended_at: opts.actualEnd ?? null,
    }).execute();
    return b.id;
  });
}

export async function addReview(biz: Biz, bookingId: string, customerId: string, rating: number, staffId?: string) {
  await withTenant(biz.tenantId, (trx) => trx.insertInto('reviews').values({ tenant_id: biz.tenantId, booking_id: bookingId, tenant_customer_id: customerId, rating, staff_id: staffId ?? null }).execute());
}

/** Marks the storefront as published (otherwise events count as owner previews). */
export async function publishStorefront(biz: Biz, userId: string) {
  await withTenant(biz.tenantId, async (trx) => {
    const v = await trx.insertInto('site_versions').values({ tenant_id: biz.tenantId, version_number: 1, snapshot: '{}', schema_version: 1, published_by: userId }).returning('id').executeTakeFirstOrThrow();
    await trx.updateTable('tenants').set({ published_version_id: v.id, status: 'active' }).where('id', '=', biz.tenantId).execute();
  });
}

export async function ownerUserId(biz: Biz) {
  return withTenant(biz.tenantId, async (trx) => (await trx.selectFrom('tenant_memberships').select('user_id').where('role', '=', 'owner').executeTakeFirstOrThrow()).user_id);
}

export const at = (iso: string) => new Date(iso);
