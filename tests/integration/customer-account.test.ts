import { describe, expect, it } from 'vitest';
import { at, customer, futureDate, makeSalon, type Salon } from '../helpers/salon';
import { withTenant } from '@/server/db/client';
import { transition } from '@/server/domains/booking/service';
import { resolveTenantAccess } from '@/server/tenancy/access';
import { resolveSession } from '@/server/auth/service';
import { tierFor } from '@/server/domains/loyalty/account';
import * as hold from '@/app/api/v1/s/[slug]/bookings/route';
import * as checkout from '@/app/api/v1/s/[slug]/bookings/[id]/checkout/route';
import * as onSite from '@/app/api/v1/t/[tenantSlug]/payments/on-site/route';
import * as loyalty from '@/app/api/v1/t/[tenantSlug]/loyalty/route';
import * as rewards from '@/app/api/v1/t/[tenantSlug]/loyalty/rewards/route';
import * as rebook from '@/app/api/v1/account/bookings/[id]/rebook/route';
import * as myLoyalty from '@/app/api/v1/account/loyalty/route';

type Client = Awaited<ReturnType<typeof customer>>;

async function book(s: Salon, c: Client, items: Array<{ service: string; staff: string; start: string }>) {
  const h = await c.call(hold.POST, { params: { slug: s.slug }, body: { items: items.map((i, k) => ({ key: `k${k}`, service_id: i.service, staff_id: i.staff, start: i.start })) }, idempotencyKey: true });
  if (h.status !== 201) throw new Error(JSON.stringify(h.body));
  await c.call(checkout.POST, { params: { slug: s.slug, id: h.body.data.booking_id }, body: { option: 'on_site' }, idempotencyKey: true });
  return h.body.data.booking_id as string;
}

async function payAndComplete(s: Salon, id: string) {
  const b = await withTenant(s.tenantId, (trx) => trx.selectFrom('bookings').select(['starts_at', 'total_minor']).where('id', '=', id).executeTakeFirstOrThrow());
  await s.owner.call(onSite.POST, { params: { tenantSlug: s.slug }, body: { booking_id: id, amount_minor: b.total_minor, method: 'cash', reference: `R-${id.slice(0, 6)}` }, idempotencyKey: true });
  const user = await resolveSession(s.owner.cookies.get('luma_session'));
  const access = await resolveTenantAccess(user!, s.slug);
  const now = new Date(b.starts_at.getTime() + 60_000);
  const actor = { kind: 'staff' as const, access, audit: { userId: user!.userId, kind: 'user' as const } };
  await transition(s.tenantId, id, 'check_in', actor, { now });
  await transition(s.tenantId, id, 'complete', actor, { now });
}

describe('rebook from /account', () => {
  it('prefills the same services and the same specialists; the customer only picks a new time', async () => {
    const s = await makeSalon();
    const c = await customer('Rebook customer');
    const id = await book(s, c, [
      { service: s.services.haircut, staff: s.staff.huda, start: at(futureDate(3), '10:00') },
      { service: s.services.nails, staff: s.staff.huda, start: at(futureDate(3), '11:00') },
    ]);
    const r = await c.call(rebook.GET, { params: { id } });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ booking_id: id, tenant_slug: s.slug, branch_id: s.branchId, bookable: true, booking_url: `/s/${s.slug}/booking?rebook=${id}` });
    expect(r.body.data.items.map((i: any) => [i.service_id, i.staff_id, i.staff_kept, i.unavailable])).toEqual([
      [s.services.haircut, s.staff.huda, true, false],
      [s.services.nails, s.staff.huda, true, false],
    ]);

    // A specialist who is no longer public is replaced by "any specialist"; an archived service is dropped.
    await withTenant(s.tenantId, async (trx) => {
      await trx.updateTable('staff_profiles').set({ is_public: false }).where('id', '=', s.staff.huda).execute();
      await trx.updateTable('services').set({ archived_at: new Date() }).where('id', '=', s.services.nails).execute();
    });
    const r2 = await c.call(rebook.GET, { params: { id } });
    expect(r2.body.data.items.map((i: any) => [i.staff_id, i.staff_kept, i.unavailable])).toEqual([[null, false, false], [null, false, true]]);

    // Another customer cannot read it.
    const other = await customer('Other');
    expect((await other.call(rebook.GET, { params: { id } })).status).toBe(404);
  });
});

describe('loyalty in /account', () => {
  it('shows balance, tier and progress per business she deals with', async () => {
    const s = await makeSalon();
    const lp = await s.owner.call(loyalty.GET, { params: { tenantSlug: s.slug } });
    const tiers = [{ code: 'silver', name_ar: 'فضي', name_en: 'Silver', min_lifetime_points: 50 }, { code: 'gold', name_ar: 'ذهبي', name_en: 'Gold', min_lifetime_points: 500 }];
    const up = await s.owner.call(loyalty.PUT, { params: { tenantSlug: s.slug }, body: { is_enabled: true, points_per_currency_unit: 1, points_expiry_days: 365, tiers, reverse_on_refund: true, version: lp.body.data.program.version } });
    expect(up.status).toBe(200);
    await s.owner.call(rewards.POST, { params: { tenantSlug: s.slug }, body: { name_ar: 'خصم ٢٠', points_cost: 80, kind: 'fixed_discount', value: 2000 } });
    // A second business without a loyalty programme is not listed.
    const other = await makeSalon();

    const c = await customer('Loyal customer');
    const id = await book(s, c, [{ service: s.services.haircut, staff: s.staff.sara, start: at(futureDate(3), '13:00') }]);
    await payAndComplete(s, id);
    await book(other, c, [{ service: other.services.haircut, staff: other.staff.sara, start: at(futureDate(3), '13:00') }]);

    const r = await c.call(myLoyalty.GET);
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveLength(1);
    const row = r.body.data[0];
    expect(row).toMatchObject({ tenant_slug: s.slug, enabled: true, balance: 100, lifetime_earned: 100, points_to_next: 400, points_per_sar: 1 });
    expect(row.tier.code).toBe('silver');
    expect(row.next_tier.code).toBe('gold');
    expect(row.expires_at).not.toBeNull();
    expect(row.rewards).toEqual([expect.objectContaining({ points_cost: 80, redeemable: true })]);

    // Someone else's account sees nothing of hers.
    const stranger = await customer('Stranger');
    expect((await stranger.call(myLoyalty.GET)).body.data).toEqual([]);
  });

  it('computes the tier from lifetime points', () => {
    const tiers = [{ code: 'gold', name_ar: '', name_en: '', min_lifetime_points: 500 }, { code: 'silver', name_ar: '', name_en: '', min_lifetime_points: 100 }];
    expect(tierFor(tiers, 0)).toMatchObject({ current: null, points_to_next: 100 });
    expect(tierFor(tiers, 100).current?.code).toBe('silver');
    expect(tierFor(tiers, 900)).toMatchObject({ current: { code: 'gold' }, next: null, points_to_next: null });
  });
});
