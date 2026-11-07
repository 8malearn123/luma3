import { describe, expect, it } from 'vitest';
import { at, customer, futureDate, makeSalon } from '../helpers/salon';
import { withSystem, withTenant } from '@/server/db/client';
import { expireStaleHolds } from '@/server/domains/booking/service';
import * as hold from '@/app/api/v1/s/[slug]/bookings/route';
import * as couponPreview from '@/app/api/v1/s/[slug]/bookings/coupon/route';
import * as checkout from '@/app/api/v1/s/[slug]/bookings/[id]/checkout/route';
import * as availability from '@/app/api/v1/s/[slug]/availability/route';
import * as coupons from '@/app/api/v1/t/[tenantSlug]/coupons/route';
import * as couponOne from '@/app/api/v1/t/[tenantSlug]/coupons/[id]/route';
import * as branches from '@/app/api/v1/t/[tenantSlug]/branches/route';
import * as schedule from '@/app/api/v1/t/[tenantSlug]/staff/[id]/schedule/route';
import * as services from '@/app/api/v1/t/[tenantSlug]/services/route';
import { servicesAtBranch, type FlowService } from '@/ui/booking/BookingFlow';
import { canGoBackSameOrigin } from '@/ui/storefront/BackArrow';

async function makeCoupon(s: Awaited<ReturnType<typeof makeSalon>>, code: string, body: Record<string, unknown>) {
  const r = await s.owner.call(coupons.POST, { params: { tenantSlug: s.slug }, body: { code, kind: 'percent', value: 2000, ...body } });
  if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  return r.body.data as { id: string };
}

describe('booking page: coupon with owner-chosen scope', () => {
  it('applies a services coupon before the deposit, rejects a products-only coupon, and re-validates on the hold', async () => {
    // 50% deposit policy: the deposit must be computed from the DISCOUNTED total.
    const s = await makeSalon({ settings: { deposit_mode: 'percent', deposit_percent_bp: 5000, allow_pay_on_site: false } });
    const svc = await makeCoupon(s, 'SVC20', { applies_to: 'services' });
    await makeCoupon(s, 'PROD20', { applies_to: 'products' });
    await makeCoupon(s, 'ALL10', { applies_to: 'all', value: 1000 });
    const c = await customer('Coupon customer');
    const items = [{ key: 'a', service_id: s.services.color, staff_id: s.staff.sara, start: at(futureDate(3), '10:00') }];

    // Preview (nothing is redeemed): 300 SAR − 20% = 240; deposit 50% of 240 = 120.
    const pv = await c.call(couponPreview.POST, { params: { slug: s.slug }, body: { code: 'svc20', items: items.map(({ start: _s, ...i }) => i) } });
    expect(pv.status).toBe(200);
    expect(pv.body.data).toMatchObject({ subtotal_minor: 30000, discount_minor: 6000, total_minor: 24000, deposit_minor: 12000 });
    const wrong = await c.call(couponPreview.POST, { params: { slug: s.slug }, body: { code: 'PROD20', items: items.map(({ start: _s, ...i }) => i) } });
    expect(wrong.status).toBe(422);
    expect(wrong.body.error.code).toBe('coupon_not_applicable');

    // The hold re-validates server-side: a products-only code is refused, nothing is held.
    const bad = await c.call(hold.POST, { params: { slug: s.slug }, body: { items, coupon_code: 'PROD20' }, idempotencyKey: true });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('coupon_not_applicable');

    const h = await c.call(hold.POST, { params: { slug: s.slug }, body: { items, coupon_code: 'SVC20' }, idempotencyKey: true });
    expect(h.status).toBe(201);
    expect(h.body.data.totals).toMatchObject({ subtotal: 30000, discount: 6000, total: 24000 });
    expect(h.body.data.payment_terms.depositMinor).toBe(12000);
    const b = await withTenant(s.tenantId, (trx) => trx.selectFrom('bookings').select(['coupon_id', 'discount_minor', 'total_minor', 'deposit_due_minor']).where('id', '=', h.body.data.booking_id).executeTakeFirstOrThrow());
    expect(b).toEqual({ coupon_id: svc.id, discount_minor: 6000, total_minor: 24000, deposit_due_minor: 12000 });
    const red = await withTenant(s.tenantId, (trx) => trx.selectFrom('coupon_redemptions').select(['status', 'discount_minor']).where('booking_id', '=', h.body.data.booking_id).execute());
    expect(red).toEqual([{ status: 'applied', discount_minor: 6000 }]);

    // Deposit checkout charges the deposit of the discounted total.
    const co = await c.call(checkout.POST, { params: { slug: s.slug, id: h.body.data.booking_id }, body: { option: 'deposit' }, idempotencyKey: true });
    expect(co.status).toBe(201);
    expect(co.body.data.payment.amount_minor).toBe(12000);

    // Per-customer limit (1): the same customer cannot use it again.
    const again = await c.call(hold.POST, { params: { slug: s.slug }, body: { items: [{ ...items[0]!, start: at(futureDate(4), '10:00') }], coupon_code: 'SVC20' }, idempotencyKey: true });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('coupon_customer_limit');
  });

  it('gives the coupon back when the hold expires, and the owner can change the scope', async () => {
    const s = await makeSalon();
    const cp = await makeCoupon(s, 'ONCE', { applies_to: 'products', max_redemptions: 1 });
    const c = await customer('Scope customer');
    const items = [{ key: 'a', service_id: s.services.haircut, staff_id: s.staff.huda, start: at(futureDate(3), '12:00') }];
    expect((await c.call(hold.POST, { params: { slug: s.slug }, body: { items, coupon_code: 'ONCE' }, idempotencyKey: true })).status).toBe(422);
    const patched = await s.owner.call(couponOne.PATCH, { params: { tenantSlug: s.slug, id: cp.id }, body: { applies_to: 'services' } });
    expect(patched.status).toBe(200);
    expect(patched.body.data.applies_to).toBe('services');
    const h = await c.call(hold.POST, { params: { slug: s.slug }, body: { items, coupon_code: 'ONCE' }, idempotencyKey: true });
    expect(h.status).toBe(201);
    const count = () => withTenant(s.tenantId, (trx) => trx.selectFrom('coupons').select('redemptions_count').where('id', '=', cp.id).executeTakeFirstOrThrow());
    expect((await count()).redemptions_count).toBe(1);
    await withSystem('test: age hold', async (trx) => {
      await trx.updateTable('bookings').set({ hold_expires_at: new Date(Date.now() - 60_000) }).where('id', '=', h.body.data.booking_id).execute();
      await trx.updateTable('booking_allocations').set({ expires_at: new Date(Date.now() - 60_000) }).where('booking_id', '=', h.body.data.booking_id).execute();
    });
    await expireStaleHolds();
    expect((await count()).redemptions_count).toBe(0);
    const red = await withTenant(s.tenantId, (trx) => trx.selectFrom('coupon_redemptions').select('status').where('booking_id', '=', h.body.data.booking_id).executeTakeFirstOrThrow());
    expect(red.status).toBe('released');
  });
});

describe('booking page: branch selection', () => {
  it('searches and books at the chosen branch; branch-only services stay at their branch', async () => {
    const s = await makeSalon();
    const b2 = await s.owner.call(branches.POST, { params: { tenantSlug: s.slug }, body: { name: 'فرع الشمال', city: 'الرياض', timezone: 'Asia/Riyadh' } });
    expect(b2.status).toBe(201);
    const north = b2.body.data.id as string;
    // Only Huda works at the north branch (mornings).
    const week = Array.from({ length: 7 }, (_, d) => ({ weekday: d, start_time: '08:00', end_time: '09:30' }));
    const sch = await s.owner.call(schedule.PUT, { params: { tenantSlug: s.slug, id: s.staff.huda }, body: { branch_id: north, ranges: week, breaks: [] } });
    expect(sch.status).toBe(200);
    const day = futureDate(5);
    const avail = await customer('Branch visitor').then((c) => c.call(availability.POST, {
      params: { slug: s.slug }, body: { branch_id: north, items: [{ key: 'a', service_id: s.services.haircut }], from: day, to: day },
    }));
    expect(avail.status).toBe(200);
    expect(avail.body.data.branch_id).toBe(north);
    const opts = avail.body.data.days[day] as Array<{ start: string; items: Array<{ staff_id: string }> }>;
    expect(opts.length).toBeGreaterThan(0);
    expect(opts.every((o) => o.items[0]!.staff_id === s.staff.huda)).toBe(true);
    expect(opts[0]!.start).toBe(new Date(at(day, '08:00')).toISOString());

    const c = await customer('North customer');
    const h = await c.call(hold.POST, { params: { slug: s.slug }, body: { branch_id: north, items: [{ key: 'a', service_id: s.services.haircut, staff_id: s.staff.huda, start: at(day, '08:00') }] }, idempotencyKey: true });
    expect(h.status).toBe(201);
    const bk = await withTenant(s.tenantId, (trx) => trx.selectFrom('bookings').select('branch_id').where('id', '=', h.body.data.booking_id).executeTakeFirstOrThrow());
    expect(bk.branch_id).toBe(north);

    // A service offered only at the main branch is refused at the north branch.
    const mainOnly = await s.owner.call(services.POST, { params: { tenantSlug: s.slug }, body: { name_ar: 'مساج', price_minor: 9000, duration_min: 30, branch_id: s.branchId, staff: [{ staff_id: s.staff.huda }] } });
    expect(mainOnly.status).toBe(201);
    const refused = await c.call(hold.POST, { params: { slug: s.slug }, body: { branch_id: north, items: [{ key: 'a', service_id: mainOnly.body.data.id, staff_id: s.staff.huda, start: at(day, '08:30') }] }, idempotencyKey: true });
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('service_not_at_branch');
  });

  it('the picker filters services and specialists to the chosen branch', () => {
    const mk = (id: string, branch: string | null, staff: Array<[string, string[]]>): FlowService => ({
      id, name_ar: id, name_en: id, description_ar: null, description_en: null, price_minor: 1000, price_display: 'fixed', duration_min: 30, category: null, branch_id: branch,
      staff: staff.map(([sid, b]) => ({ id: sid, name: sid, name_en: null, title_ar: null, title_en: null, photo: null, branch_ids: b })),
    });
    const all = [mk('cut', null, [['sara', ['main']], ['huda', ['main', 'north']]]), mk('spa', 'main', [['huda', ['main', 'north']]]), mk('nails', null, [['sara', ['main']]])];
    const north = servicesAtBranch(all, 'north');
    expect(north.map((x) => x.id)).toEqual(['cut']);
    expect(north[0]!.staff.map((x) => x.id)).toEqual(['huda']);
    expect(servicesAtBranch(all, null)).toBe(all);
  });
});

describe('smart back arrow', () => {
  const loc = { origin: 'https://luma.sa' };
  it('goes back only when a same-origin entry is behind, else to the storefront home', () => {
    expect(canGoBackSameOrigin({ navigation: { canGoBack: true }, history: { length: 3 }, location: loc }, '')).toBe(true);
    expect(canGoBackSameOrigin({ navigation: { canGoBack: false }, history: { length: 3 }, location: loc }, 'https://luma.sa/s/x')).toBe(false);
    expect(canGoBackSameOrigin({ history: { length: 2 }, location: loc }, 'https://luma.sa/s/x/services')).toBe(true);
    expect(canGoBackSameOrigin({ history: { length: 2 }, location: loc }, 'https://l.instagram.com/')).toBe(false);
    expect(canGoBackSameOrigin({ history: { length: 1 }, location: loc }, 'https://luma.sa/s/x')).toBe(false);
  });
});
