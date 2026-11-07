import { beforeAll, describe, expect, it } from 'vitest';
import { withSystem, withTenant } from '@/server/db/client';
import { normalizeIban, requiredDocKinds } from '@/server/domains/marketplace/rules';
import * as search from '@/app/api/v1/market/search/route';
import * as listing from '@/app/api/v1/t/[tenantSlug]/marketplace/route';
import * as categories from '@/app/api/v1/t/[tenantSlug]/categories/route';
import * as services from '@/app/api/v1/t/[tenantSlug]/services/route';
import { TestClient } from '../helpers/http';
import { listedBusiness, publish } from '../helpers/market';
import { makeSalon, type Salon } from '../helpers/salon';

const CARD_KEYS = ['business_type', 'city', 'cover_url', 'currency', 'distance_km', 'favorite', 'logo_url', 'name', 'rating_avg', 'rating_count', 'slug', 'specialties', 'starting_price_minor', 'tagline_ar', 'tagline_en', 'verified'].sort();

async function find(q: Record<string, string>) {
  const r = await new TestClient().call(search.GET, { query: { limit: '48', ...q } });
  expect(r.status).toBe(200);
  return r.body.data as { items: Array<Record<string, any>>; total: number; facets: any };
}

async function rate(s: Salon, ratings: number[]) {
  await withTenant(s.tenantId, async (trx) => {
    const c = await trx.insertInto('tenant_customers').values({ tenant_id: s.tenantId, display_name: 'C' }).returning('id').executeTakeFirstOrThrow();
    for (const [i, r] of ratings.entries()) {
      const start = new Date(Date.now() - (i + 2) * 86_400_000);
      const b = await trx.insertInto('bookings').values({
        tenant_id: s.tenantId, branch_id: s.branchId, number: `R-${i}-${Math.random().toString(36).slice(2, 6)}`, tenant_customer_id: c.id, status: 'completed', source: 'dashboard',
        starts_at: start, ends_at: new Date(start.getTime() + 3_600_000), timezone: 'Asia/Riyadh', subtotal_minor: 0, total_minor: 0,
      }).returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('reviews').values({ tenant_id: s.tenantId, booking_id: b.id, tenant_customer_id: c.id, rating: r }).execute();
    }
  });
}

describe('سوق لوما discover', () => {
  let a: Salon, b: Salon, expert: Salon, hidden: Salon, pending: Salon;
  const city = `مدينة-${Math.random().toString(36).slice(2, 7)}`;

  beforeAll(async () => {
    a = await listedBusiness({ name: 'صالون الورد', city, lat: 24.7136, lng: 46.6753 });
    b = await listedBusiness({ name: 'صالون اللؤلؤ', city, lat: 21.4858, lng: 39.1925 });
    expert = await listedBusiness({ type: 'expert', name: 'خبيرة مكياج', city });
    hidden = await listedBusiness({ name: 'صالون مخفي', city });
    await hidden.owner.call(listing.PATCH, { params: { tenantSlug: hidden.slug }, body: { hidden: true }, method: 'PATCH' });
    // Published but never approved.
    pending = await makeSalon();
    await withTenant(pending.tenantId, (trx) => trx.updateTable('tenants').set({ city }).where('id', '=', pending.tenantId).execute());
    await publish(pending);
    // Specialty from service categories (salon a only) and prices.
    const cat = await a.owner.call(categories.POST, { params: { tenantSlug: a.slug }, body: { kind: 'service', name_ar: 'عناية بالبشرة', slug: 'skin' } });
    expect(cat.status).toBe(201);
    const svc = await a.owner.call(services.POST, { params: { tenantSlug: a.slug }, body: { name_ar: 'تنظيف بشرة', price_minor: 5000, duration_min: 45, category_id: cat.body.data.id, staff: [{ staff_id: a.staff.sara }] } });
    expect(svc.status).toBe(201);
    await withTenant(b.tenantId, (trx) => trx.updateTable('services').set({ price_minor: 20000 }).where('tenant_id', '=', b.tenantId).execute());
    await rate(a, [5, 4]);
    await rate(b, [5, 5, 5]);
  });

  it('lists only approved, visible, active, published businesses with public card fields only', async () => {
    const r = await find({ city });
    const slugs = r.items.map((i) => i.slug);
    expect(slugs.sort()).toEqual([a.slug, b.slug, expert.slug].sort());
    expect(slugs).not.toContain(hidden.slug);
    expect(slugs).not.toContain(pending.slug);
    for (const it of r.items) {
      expect(Object.keys(it).sort()).toEqual(CARD_KEYS);
      expect(it.verified).toBe(true);
    }
    const raw = JSON.stringify(r);
    for (const t of [a, b, expert]) expect(raw).not.toContain(t.tenantId);
    expect(raw).not.toMatch(/iban|commission|owner|email|phone|SA03/i);
  });

  it('suspended businesses disappear', async () => {
    await withSystem('test', (trx) => trx.updateTable('tenants').set({ status: 'suspended' }).where('id', '=', b.tenantId).execute());
    expect((await find({ city })).items.map((i) => i.slug)).not.toContain(b.slug);
    await withSystem('test', (trx) => trx.updateTable('tenants').set({ status: 'active' }).where('id', '=', b.tenantId).execute());
  });

  it('filters by door/type, specialty (from service categories), rating and price', async () => {
    expect((await find({ city, door: 'experts' })).items.map((i) => i.slug)).toEqual([expert.slug]);
    expect((await find({ city, door: 'salons' })).items.map((i) => i.slug).sort()).toEqual([a.slug, b.slug].sort());
    const sp = await find({ city, specialty: 'عناية بالبشرة' });
    expect(sp.items.map((i) => i.slug)).toEqual([a.slug]);
    expect((await find({ city })).facets.specialties.map((x: any) => x.name_ar)).toContain('عناية بالبشرة');
    expect((await find({ city, min_rating: '4.9' })).items.map((i) => i.slug)).toEqual([b.slug]);
    // Starting price = cheapest visible service: a 5000, expert 8000, b 20000.
    expect((await find({ city, price_max: '9000' })).items.map((i) => i.slug).sort()).toEqual([a.slug, expert.slug].sort());
    expect((await find({ city, price_min: '10000' })).items.map((i) => i.slug)).toEqual([b.slug]);
    expect((await find({ city, q: 'اللؤلؤ' })).items.map((i) => i.slug)).toEqual([b.slug]);
    expect((await find({ city, q: 'تنظيف' })).items.map((i) => i.slug)).toEqual([a.slug]);
  });

  it('sorts: top rated, price, nearest (branch coordinates)', async () => {
    expect((await find({ city, sort: 'top_rated' })).items.map((i) => i.slug).slice(0, 2)).toEqual([b.slug, a.slug]);
    expect((await find({ city, sort: 'price_asc' })).items.map((i) => i.slug)).toEqual([a.slug, expert.slug, b.slug]);
    expect((await find({ city, sort: 'price_desc' })).items.map((i) => i.slug)).toEqual([b.slug, expert.slug, a.slug]);
    // Near Jeddah → b first; no coordinates → last.
    const near = await find({ city, sort: 'nearest', lat: '21.5', lng: '39.2' });
    expect(near.items.map((i) => i.slug)).toEqual([b.slug, a.slug, expert.slug]);
    expect(near.items[0]!.distance_km).toBeLessThan(5);
    expect(near.items[2]!.distance_km).toBeNull();
    expect((await find({ city, sort: 'most_booked' })).items[0]!.slug).toBe(b.slug);
  });

  it('rules: documents by business type and IBAN check', () => {
    expect(requiredDocKinds('salon')).toEqual(['commercial_register', 'owner_id', 'iban']);
    expect(requiredDocKinds('expert')).toEqual(['freelance_document', 'owner_id', 'iban']);
    expect(normalizeIban('sa03 8000 0000 6080 1016 7519')).toBe('SA0380000000608010167519');
    expect(normalizeIban('SA0380000000608010167518')).toBeNull();
  });
});
