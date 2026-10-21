import { describe, expect, it } from 'vitest';
import { createBusinessFor, signup } from '../helpers/factory';
import * as services from '@/app/api/v1/t/[tenantSlug]/services/route';
import * as serviceOne from '@/app/api/v1/t/[tenantSlug]/services/[id]/route';
import * as variants from '@/app/api/v1/t/[tenantSlug]/services/[id]/variants/route';
import * as addons from '@/app/api/v1/t/[tenantSlug]/services/[id]/addons/route';
import * as variantOne from '@/app/api/v1/t/[tenantSlug]/variants/[id]/route';
import * as addonOne from '@/app/api/v1/t/[tenantSlug]/addons/[id]/route';
import * as staff from '@/app/api/v1/t/[tenantSlug]/staff/route';
import * as staffOne from '@/app/api/v1/t/[tenantSlug]/staff/[id]/route';

/** Partial updates (PATCH) change only the fields sent: omitted fields keep their stored values. */
describe('catalog & team partial updates', () => {
  it('variant and add-on PATCH change only the sent fields', async () => {
    const owner = await signup('Owner');
    const biz = await createBusinessFor(owner);
    const p = { tenantSlug: biz.slug };
    const svc = await owner.call(services.POST, { params: p, body: { name_ar: 'خدمة', price_minor: 10000, duration_min: 60 } });
    expect(svc.status).toBe(201);
    const sid = svc.body.data.id as string;

    const v = await owner.call(variants.POST, { params: { ...p, id: sid }, body: { name_en: 'Long hair', price_minor: 12000, duration_min: 75 } });
    expect(v.status).toBe(201);
    const off = await owner.call(variantOne.PATCH, { method: 'PATCH', params: { ...p, id: v.body.data.id }, body: { is_active: false } });
    expect(off.status).toBe(200);
    const price = await owner.call(variantOne.PATCH, { method: 'PATCH', params: { ...p, id: v.body.data.id }, body: { price_minor: 13000 } });
    expect(price.status).toBe(200);
    expect(price.body.data).toMatchObject({ price_minor: 13000, duration_min: 75, is_active: false, name_en: 'Long hair' });

    const a = await owner.call(addons.POST, { params: { ...p, id: sid }, body: { name_en: 'Mask', price_minor: 3000, duration_min: 15 } });
    expect(a.status).toBe(201);
    const ap = await owner.call(addonOne.PATCH, { method: 'PATCH', params: { ...p, id: a.body.data.id }, body: { price_minor: 3500 } });
    expect(ap.status).toBe(200);
    expect(ap.body.data).toMatchObject({ price_minor: 3500, duration_min: 15, is_active: true });

    const bad = await owner.call(addonOne.PATCH, { method: 'PATCH', params: { ...p, id: a.body.data.id }, body: { duration_min: 999 } });
    expect(bad.status).toBe(422);

    const full = await owner.call(serviceOne.GET, { params: { ...p, id: sid } });
    expect(full.body.data.variants).toHaveLength(1);
    expect(full.body.data.addons).toHaveLength(1);
  });

  it('staff PATCH keeps is_public when it is not sent', async () => {
    const owner = await signup('Owner');
    const biz = await createBusinessFor(owner);
    const p = { tenantSlug: biz.slug };
    const s = await owner.call(staff.POST, { params: p, body: { display_name: 'Private', is_public: false } });
    expect(s.status).toBe(201);
    const r = await owner.call(staffOne.PATCH, { method: 'PATCH', params: { ...p, id: s.body.data.id }, body: { title_en: 'Stylist' } });
    expect(r.status).toBe(200);
    const list = await owner.call(staff.GET, { params: p });
    const row = list.body.data.find((x: { id: string }) => x.id === s.body.data.id);
    expect(row).toMatchObject({ is_public: false, title_en: 'Stylist' });
  });
});
