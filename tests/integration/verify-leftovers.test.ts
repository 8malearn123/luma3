import { describe, expect, it } from 'vitest';
import { withSystem, withTenant } from '@/server/db/client';
import * as hold from '@/app/api/v1/s/[slug]/bookings/route';
import * as storefrontBooking from '@/app/api/v1/s/[slug]/bookings/[id]/route';
import * as availability from '@/app/api/v1/s/[slug]/availability/route';
import * as storefrontOrder from '@/app/api/v1/s/[slug]/orders/[id]/route';
import * as accBookings from '@/app/api/v1/account/bookings/route';
import * as accBooking from '@/app/api/v1/account/bookings/[id]/route';
import { localizedTaxLabel } from '@/shared/tax-label';
import { at, customer, futureDate, makeSalon } from '../helpers/salon';
import { addToCart, checkout as placeOrder, createProduct, liveShop } from '../helpers/commerce';

/**
 * LUMA-AUDIT-039 leftovers: the English UI gets the specialist's English name
 * (read live; the Arabic snapshot on booking_items is kept and stays the
 * fallback) and the business's own tax label on both checkouts.
 */
const TAX_AR = 'ضريبة القيمة المضافة';

describe('localized staff names and tax label on customer read paths (039)', () => {
  it('search options, checkout, account list and detail carry staff_name_en; the snapshot is untouched', async () => {
    const s = await makeSalon({ settings: { tax_label: TAX_AR, tax_rate_bp: 1500 } });
    await withSystem('test: arabic name + english name', (trx) => trx.updateTable('staff_profiles').set({ display_name: 'سارة', display_name_en: 'Sara' }).where('id', '=', s.staff.sara).execute());
    const c = await customer();
    const d = futureDate(4);

    const av = await c.call(availability.POST, { params: { slug: s.slug }, body: { items: [{ key: 'x', service_id: s.services.haircut, staff_id: s.staff.sara }], from: d, to: d } });
    expect(av.status).toBe(200);
    expect(av.body.data.days[d][0].items[0]).toMatchObject({ staff_name: 'سارة', staff_name_en: 'Sara' });

    const h = await c.call(hold.POST, { params: { slug: s.slug }, body: { items: [{ key: 'x', service_id: s.services.haircut, staff_id: s.staff.sara, start: at(d, '11:00') }] }, idempotencyKey: true });
    expect(h.status).toBe(201);
    const id = h.body.data.booking_id as string;

    const co = await c.call(storefrontBooking.GET, { params: { slug: s.slug, id } });
    expect(co.status).toBe(200);
    expect(co.body.data.items[0]).toMatchObject({ staff_name: 'سارة', staff_name_en: 'Sara' });
    // Booking checkout: the business's label comes from the booking's policy snapshot.
    expect(co.body.data.policy_snapshot.tax_label).toBe(TAX_AR);
    expect(localizedTaxLabel(co.body.data.policy_snapshot.tax_label, 'en', 'Tax')).toBe('Tax');
    expect(localizedTaxLabel(co.body.data.policy_snapshot.tax_label, 'ar', 'الضريبة')).toBe(TAX_AR);

    const list = await c.call(accBookings.GET);
    expect(list.body.data.find((b: { id: string }) => b.id === id).items).toEqual([expect.objectContaining({ staff_name: 'سارة', staff_name_en: 'Sara' })]);
    const detail = await c.call(accBooking.GET, { params: { id } });
    expect(detail.body.data.items[0]).toMatchObject({ staff_name: 'سارة', staff_name_en: 'Sara' });

    // The stored snapshot is not rewritten.
    const snap = await withTenant(s.tenantId, (trx) => trx.selectFrom('booking_items').select('staff_name').where('booking_id', '=', id).executeTakeFirstOrThrow());
    expect(snap.staff_name).toBe('سارة');

    // No English name → the Arabic snapshot is the fallback (null, never a made-up name).
    await withSystem('test: clear english name', (trx) => trx.updateTable('staff_profiles').set({ display_name_en: null }).where('id', '=', s.staff.sara).execute());
    const again = await c.call(storefrontBooking.GET, { params: { slug: s.slug, id } });
    expect(again.body.data.items[0]).toMatchObject({ staff_name: 'سارة', staff_name_en: null });
  });

  it('order checkout carries the business tax label', async () => {
    const { owner, biz } = await liveShop();
    await withSystem('test: tax label', (trx) => trx.updateTable('tenant_settings').set({ tax_label: TAX_AR, tax_rate_bp: 1500 }).where('tenant_id', '=', biz.tenantId).execute());
    const prod = await createProduct(owner, biz.slug);
    const c = await customer();
    await addToCart(c, biz.slug, prod.variants[0]!.id, 1);
    const r = await placeOrder(c, biz.slug, {});
    expect(r.status).toBe(201);
    const o = await c.call(storefrontOrder.GET, { params: { slug: biz.slug, id: r.body.data.id } });
    expect(o.status).toBe(200);
    expect(o.body.data.tax_label).toBe(TAX_AR);
    expect(localizedTaxLabel(o.body.data.tax_label, 'en', 'Tax')).toBe('Tax');
  });
});
