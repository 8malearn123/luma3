import { DateTime } from 'luxon';
import { withSystem } from '@/server/db/client';
import { createBusinessFor, signup } from './factory';
import type { TestClient } from './http';
import * as services from '@/app/api/v1/t/[tenantSlug]/services/route';
import * as staff from '@/app/api/v1/t/[tenantSlug]/staff/route';
import * as schedule from '@/app/api/v1/t/[tenantSlug]/staff/[id]/schedule/route';
import * as accounts from '@/app/api/v1/t/[tenantSlug]/payment-accounts/route';
import * as reauth from '@/app/api/v1/auth/reauth/route';

export const TZ = 'Asia/Riyadh';

/** A local date at least `daysAhead` days in the future (Riyadh), as YYYY-MM-DD. */
export function futureDate(daysAhead = 3) {
  return DateTime.now().setZone(TZ).plus({ days: daysAhead }).toISODate()!;
}
export function at(date: string, hhmm: string) {
  return DateTime.fromISO(`${date}T${hhmm}`, { zone: TZ }).toISO()!;
}

/**
 * A published-equivalent salon: owner, two specialists working 10:00–18:00
 * every day, services, sandbox payments connected, status active.
 */
export async function makeSalon(opts: { settings?: Record<string, unknown>; plan?: string } = {}) {
  const owner = await signup('Owner');
  const biz = await createBusinessFor(owner, { plan_code: opts.plan ?? 'wahaj' });
  const p = { tenantSlug: biz.slug };
  const mk = async (name: string) => (await owner.call(staff.POST, { params: p, body: { display_name: name } })).body.data.id as string;
  const sara = await mk('Sara');
  const huda = await mk('Huda');
  const week = Array.from({ length: 7 }, (_, d) => ({ weekday: d, start_time: '10:00', end_time: '18:00' }));
  for (const s of [sara, huda]) {
    const r = await owner.call(schedule.PUT, { params: { ...p, id: s }, body: { branch_id: biz.branchId, ranges: week, breaks: [] } });
    if (r.status !== 200) throw new Error(JSON.stringify(r.body));
  }
  const svc = async (body: Record<string, unknown>) => {
    const r = await owner.call(services.POST, { params: p, body });
    if (r.status !== 201) throw new Error(JSON.stringify(r.body));
    return r.body.data.id as string;
  };
  const haircut = await svc({ name_ar: 'قص شعر', price_minor: 10000, duration_min: 60, staff: [{ staff_id: sara }, { staff_id: huda }] });
  const color = await svc({ name_ar: 'صبغة', price_minor: 30000, duration_min: 90, buffer_after_min: 15, staff: [{ staff_id: sara }] });
  const nails = await svc({ name_ar: 'أظافر', price_minor: 8000, duration_min: 30, staff: [{ staff_id: huda }] });
  await owner.call(reauth.POST, { body: { password: 'correct horse battery' } });
  const acct = await owner.call(accounts.POST, { params: p, body: { provider: 'sandbox' } });
  if (acct.status !== 201) throw new Error(JSON.stringify(acct.body));
  await withSystem('test: activate tenant', async (trx) => {
    await trx.updateTable('tenants').set({ status: 'active' }).where('id', '=', biz.tenantId).execute();
    await trx.updateTable('tenant_settings').set({ min_notice_min: 0, slot_increment_min: 30, ...(opts.settings ?? {}) }).where('tenant_id', '=', biz.tenantId).execute();
  });
  return { owner, biz, slug: biz.slug, tenantId: biz.tenantId, branchId: biz.branchId, staff: { sara, huda }, services: { haircut, color, nails } };
}

export type Salon = Awaited<ReturnType<typeof makeSalon>>;

export async function customer(name = 'Customer'): Promise<TestClient & { identifier: string }> {
  return signup(name);
}
