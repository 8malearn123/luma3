import { DateTime } from 'luxon';
import { randomUUID } from 'node:crypto';
import { withSystem, withTenant } from '@/server/db/client';
import type { TestClient } from './http';

/** Fixtures for the business dashboard tests (direct SQL for bookings/payments owned by other domains). */
export const TZ = 'Asia/Riyadh';
type Biz = { tenantId: string; branchId: string };

/** Local (Riyadh) today at HH:MM, as a Date. */
export function todayAt(hhmm: string, plusDays = 0) {
  const [h, m] = hhmm.split(':').map(Number);
  return DateTime.now().setZone(TZ).startOf('day').plus({ days: plusDays }).set({ hour: h, minute: m }).toJSDate();
}

export async function userIdOf(c: TestClient & { identifier: string }) {
  return withSystem('test: user id', async (trx) => (await trx.selectFrom('users').select('id').where((eb) => eb.or([eb('email', '=', c.identifier), eb('phone', '=', c.identifier)])).executeTakeFirstOrThrow()).id);
}

export async function staffWithHours(biz: Biz, name: string, branchId = biz.branchId, opts: { userId?: string } = {}) {
  return withTenant(biz.tenantId, async (trx) => {
    const s = await trx.insertInto('staff_profiles').values({ tenant_id: biz.tenantId, display_name: name }).returning('id').executeTakeFirstOrThrow();
    await trx.insertInto('staff_branch_assignments').values({ tenant_id: biz.tenantId, staff_id: s.id, branch_id: branchId }).execute();
    await trx.insertInto('working_hours').values(Array.from({ length: 7 }, (_, wd) => ({ tenant_id: biz.tenantId, staff_id: s.id, branch_id: branchId, weekday: wd, start_time: '00:00', end_time: '23:59' }))).execute();
    if (opts.userId) await trx.updateTable('tenant_memberships').set({ staff_profile_id: s.id }).where('user_id', '=', opts.userId).execute();
    return s.id;
  });
}

export async function service(biz: Biz, name = 'قص', price = 10000) {
  return withTenant(biz.tenantId, async (trx) => (await trx.insertInto('services').values({ tenant_id: biz.tenantId, name_ar: name, name_en: name, price_minor: price, duration_min: 60 }).returning('id').executeTakeFirstOrThrow()).id);
}

export async function customer(biz: Biz, name = 'نورة العتيبي') {
  return withTenant(biz.tenantId, async (trx) => (await trx.insertInto('tenant_customers').values({ tenant_id: biz.tenantId, display_name: name }).returning('id').executeTakeFirstOrThrow()).id);
}

export async function booking(biz: Biz, o: { customerId: string; serviceId: string; staffId: string; startsAt: Date; status?: string; price?: number; branchId?: string; capture?: boolean; collectedBy?: string }) {
  const price = o.price ?? 10000;
  const ends = new Date(o.startsAt.getTime() + 60 * 60_000);
  return withTenant(biz.tenantId, async (trx) => {
    const b = await trx.insertInto('bookings').values({
      tenant_id: biz.tenantId, branch_id: o.branchId ?? biz.branchId, number: `T-${randomUUID().slice(0, 12)}`, tenant_customer_id: o.customerId,
      status: o.status ?? 'confirmed', source: 'dashboard', starts_at: o.startsAt, ends_at: ends, timezone: TZ, subtotal_minor: price, total_minor: price,
    }).returning('id').executeTakeFirstOrThrow();
    await trx.insertInto('booking_items').values({
      tenant_id: biz.tenantId, booking_id: b.id, sequence: 1, service_id: o.serviceId, staff_id: o.staffId, starts_at: o.startsAt, ends_at: ends,
      staff_name: 'S', service_name_ar: 'قص', duration_min: 60, unit_price_minor: price, line_total_minor: price,
    }).execute();
    if (o.capture) {
      await trx.insertInto('payments').values({
        tenant_id: biz.tenantId, booking_id: b.id, purpose: 'booking', kind: 'on_site', method: 'cash', amount_minor: price, collected_by: o.collectedBy ?? null, cash_reference: 'T-1', currency: 'SAR',
        status: 'captured', captured_at: new Date(), provider: 'on_site', idempotency_key: `t-${randomUUID()}`,
      }).execute();
    }
    return b.id;
  });
}
