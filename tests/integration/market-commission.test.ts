import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { withTenant } from '@/server/db/client';
import * as hold from '@/app/api/v1/s/[slug]/bookings/route';
import * as checkout from '@/app/api/v1/s/[slug]/bookings/[id]/checkout/route';
import * as visit from '@/app/api/v1/s/[slug]/market-visit/route';
import * as sandboxPay from '@/app/api/v1/sandbox/checkout/[providerPaymentId]/route';
import * as fees from '@/app/api/v1/t/[tenantSlug]/finance/marketplace-fees/route';
import * as platformFees from '@/app/api/v1/platform/marketplace/fees/route';
import * as commission from '@/app/api/v1/platform/marketplace/tenants/[tenantId]/commission/route';
import { transition } from '@/server/domains/booking/service';
import { marketplaceFeesFor } from '@/server/domains/marketplace/attribution';
import { resolveTenantAccess } from '@/server/tenancy/access';
import { resolveSession } from '@/server/auth/service';
import { at, customer, futureDate, makeSalon, type Salon } from '../helpers/salon';
import { addMember, stepUp } from '../helpers/platform';
import { listedBusiness, marketAdmin } from '../helpers/market';

const sid = () => `mkt${Math.random().toString(36).slice(2, 14)}`;

async function book(s: Salon, start: string, session: string | null, option: 'full' | 'on_site') {
  const c = await customer();
  const headers = session ? { 'x-luma-session': session } : undefined;
  const h = await c.call(hold.POST, { params: { slug: s.slug }, headers, body: { items: [{ key: 'x', service_id: s.services.haircut, staff_id: s.staff.sara, start }] }, idempotencyKey: true });
  expect(h.status).toBe(201);
  const id = h.body.data.booking_id as string;
  const co = await c.call(checkout.POST, { params: { slug: s.slug, id }, headers, body: { option }, idempotencyKey: true });
  expect(co.status).toBeLessThan(300);
  if (option === 'full') {
    const p = await withTenant(s.tenantId, (trx) => trx.selectFrom('payments').select('provider_payment_id').where('booking_id', '=', id).executeTakeFirstOrThrow());
    const cap = await c.call(sandboxPay.POST, { params: { providerPaymentId: p.provider_payment_id! }, body: { outcome: 'captured' } });
    expect(cap.body.data.webhook).toBe('processed');
  }
  return id;
}

async function complete(s: Salon, id: string) {
  const user = await resolveSession(s.owner.cookies.get('luma_session'));
  const access = await resolveTenantAccess(user!, s.slug);
  const b = await withTenant(s.tenantId, (trx) => trx.selectFrom('bookings').select('starts_at').where('id', '=', id).executeTakeFirstOrThrow());
  const now = new Date(b.starts_at.getTime() + 60_000);
  const actor = { kind: 'staff' as const, access, audit: { userId: user!.userId, kind: 'user' as const } };
  await transition(s.tenantId, id, 'check_in', actor, { now });
  await transition(s.tenantId, id, 'complete', actor, { now });
}

const bookingRow = (s: Salon, id: string) => withTenant(s.tenantId, (trx) => trx.selectFrom('bookings').select(['channel', 'marketplace_fee_bp', 'attribution']).where('id', '=', id).executeTakeFirstOrThrow());
const lines = (s: Salon) => withTenant(s.tenantId, (trx) => trx.selectFrom('marketplace_commissions').selectAll().execute());
const today = () => DateTime.now().setZone('Asia/Riyadh').toISODate()!;

describe('سوق لوما: attribution and LUMA commission', () => {
  it('only marketplace bookings carry a commission, at the per-business rate', async () => {
    const s = await listedBusiness({ commissionBp: 1500 });
    const day = futureDate(5);

    // Arrived from /discover (same analytics session) → marketplace.
    const session = sid();
    const v = await (await customer()).call(visit.POST, { params: { slug: s.slug }, headers: { 'x-luma-session': session }, body: {} });
    expect(v.status).toBe(202);
    expect(v.body.data.recorded).toBe(true);
    const mkt = await book(s, at(day, '10:00'), session, 'full');
    const mb = await bookingRow(s, mkt);
    expect(mb.channel).toBe('marketplace');
    expect(mb.marketplace_fee_bp).toBe(1500);
    expect(mb.attribution).toMatchObject({ source: 'marketplace', commission_bp: 1500 });
    // «كيف عرفتِ عنا؟»: a customer who arrived from سوق لوما is recorded with source «سوق لوما».
    const acq = await withTenant(s.tenantId, (trx) => trx.selectFrom('bookings as b').innerJoin('tenant_customers as c', 'c.id', 'b.tenant_customer_id')
      .select(['c.acquisition_source', 'c.acquisition_method']).where('b.id', '=', mkt).executeTakeFirstOrThrow());
    expect(acq).toEqual({ acquisition_source: 'marketplace', acquisition_method: 'inferred' });

    // Split-payment data on the online payment: fee + provider net.
    const pay = await withTenant(s.tenantId, (trx) => trx.selectFrom('payments').select(['amount_minor', 'platform_fee_minor', 'provider_net_minor', 'status']).where('booking_id', '=', mkt).executeTakeFirstOrThrow());
    expect(pay).toMatchObject({ amount_minor: 10000, platform_fee_minor: 1500, provider_net_minor: 8500, status: 'captured' });

    // Direct storefront booking (no marketplace visit in its session) → no commission.
    const direct = await book(s, at(day, '12:00'), sid(), 'on_site');
    expect((await bookingRow(s, direct)).channel).toBe('direct');
    const noSession = await book(s, at(day, '14:00'), null, 'full');
    expect((await bookingRow(s, noSession)).channel).toBe('direct');
    expect((await withTenant(s.tenantId, (trx) => trx.selectFrom('payments').select('platform_fee_minor').where('booking_id', '=', noSession).executeTakeFirstOrThrow())).platform_fee_minor).toBe(0);

    // A rate change later does not touch the snapshotted rate.
    const admin = await marketAdmin();
    await stepUp(admin);
    await admin.call(commission.PUT, { method: 'PUT', params: { tenantId: s.tenantId }, body: { commission_bp: 500 } });

    expect(await lines(s)).toEqual([]);
    for (const id of [mkt, direct, noSession]) await complete(s, id);
    const l = await lines(s);
    expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({ booking_id: mkt, base_minor: 10000, rate_bp: 1500, fee_minor: 1500, settlement: 'simulated' });

    // Domain contract for payouts/finance.
    const f = await marketplaceFeesFor(s.tenantId, { from: today(), to: today() });
    expect(f).toMatchObject({ bookings: 1, base_minor: 10000, fee_minor: 1500, simulated_fee_minor: 1500, pending_fee_minor: 0, currency: 'SAR' });
    expect((await marketplaceFeesFor(s.tenantId, { from: '2020-01-01', to: '2020-01-31' })).bookings).toBe(0);

    // Finance view for the business (finance.view) and the platform ledger.
    const fin = await s.owner.call(fees.GET, { params: { tenantSlug: s.slug }, query: { from: today(), to: today() } });
    expect(fin.body.data.fee_minor).toBe(1500);
    const rec = await addMember(s.owner, s.slug, 'receptionist');
    expect((await rec.call(fees.GET, { params: { tenantSlug: s.slug }, query: { from: today(), to: today() } })).status).toBe(403);
    const pf = await admin.call(platformFees.GET, { query: { from: '2020-01-01', to: '2099-12-31' } });
    expect(pf.body.data.items.find((i: any) => i.tenant_id === s.tenantId)).toMatchObject({ bookings: 1, fee_minor: 1500 });
    // Another business cannot read this ledger (RLS).
    const other = await makeSalon();
    expect(await withTenant(other.tenantId, (trx) => trx.selectFrom('marketplace_commissions').select('id').where('tenant_id', '=', s.tenantId).execute())).toEqual([]);
    // Append-only.
    await expect(withTenant(s.tenantId, (trx) => trx.updateTable('marketplace_commissions').set({ fee_minor: 0 }).where('tenant_id', '=', s.tenantId).execute())).rejects.toThrow();
  });

  it('default rate applies; visits to unlisted businesses never attribute', async () => {
    const s = await listedBusiness();
    const session = sid();
    await (await customer()).call(visit.POST, { params: { slug: s.slug }, headers: { 'x-luma-session': session }, body: {} });
    const id = await book(s, at(futureDate(6), '10:00'), session, 'on_site');
    expect((await bookingRow(s, id)).marketplace_fee_bp).toBe(1000);
    await complete(s, id);
    expect((await lines(s))[0]).toMatchObject({ rate_bp: 1000, fee_minor: 1000, settlement: 'simulated' });

    const plain = await makeSalon();
    const sess2 = sid();
    const v = await (await customer()).call(visit.POST, { params: { slug: plain.slug }, headers: { 'x-luma-session': sess2 }, body: {} });
    expect(v.body.data.recorded).toBe(false);
    const id2 = await book(plain, at(futureDate(6), '11:00'), sess2, 'on_site');
    expect((await bookingRow(plain, id2)).channel).toBe('direct');
  });
});
