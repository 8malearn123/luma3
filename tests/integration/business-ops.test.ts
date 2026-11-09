import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import sharp from 'sharp';
import { DateTime } from 'luxon';
import { withTenant } from '@/server/db/client';
import { loadLiveCatalog } from '@/server/domains/storefront/service';
import { runDueDigests } from '@/server/domains/business/digest';
import { addMember, liveShop } from '../helpers/commerce';
import { booking, customer, service, staffWithHours, todayAt } from '../helpers/business';
import * as items from '@/app/api/v1/t/[tenantSlug]/inventory/items/route';
import * as itemMoves from '@/app/api/v1/t/[tenantSlug]/inventory/items/[id]/movements/route';
import * as services from '@/app/api/v1/t/[tenantSlug]/services/route';
import * as serviceOne from '@/app/api/v1/t/[tenantSlug]/services/[id]/route';
import * as digestSettings from '@/app/api/v1/t/[tenantSlug]/settings/digest/route';
import * as digests from '@/app/api/v1/t/[tenantSlug]/digests/route';
import * as digestOne from '@/app/api/v1/t/[tenantSlug]/digests/[id]/route';
import * as assets from '@/app/api/v1/t/[tenantSlug]/assets/route';
import * as assetCrop from '@/app/api/v1/t/[tenantSlug]/assets/[id]/crop/route';
import * as zatca from '@/app/api/v1/t/[tenantSlug]/finance/zatca/route';

async function lowStockNotes(tenantId: string) {
  return withTenant(tenantId, (trx) => trx.selectFrom('notifications').select(['user_id', 'dedupe_key']).where('kind', '=', 'inventory.low_stock').execute());
}

describe('low-stock alerts', () => {
  it('alerts the owner and inventory managers once per crossing, and again only after a restock', async () => {
    const shop = await liveShop('wahaj');
    const manager = await addMember(shop.owner, shop.biz.slug, 'manager'); // inventory.manage by default
    await addMember(shop.owner, shop.biz.slug, 'receptionist'); // inventory.view only: never alerted
    const dye = (await shop.owner.call(items.POST, { params: shop.p, body: { name: 'صبغة', unit: 'ml', initial_quantity: 500, low_stock_threshold: 100 } })).body.data;
    const move = (body: Record<string, unknown>) => shop.owner.call(itemMoves.POST, { params: { ...shop.p, id: dye.id }, body });
    expect((await move({ kind: 'adjustment', quantity: -350, reason: 'use' })).status).toBe(201); // 150 > 100: no alert
    expect(await lowStockNotes(shop.biz.tenantId)).toHaveLength(0);
    await move({ kind: 'adjustment', quantity: -60, reason: 'use' }); // 90: crosses → alert owner + manager
    const first = await lowStockNotes(shop.biz.tenantId);
    expect(first).toHaveLength(2);
    expect(new Set(first.map((n) => n.dedupe_key)).size).toBe(1);
    await move({ kind: 'adjustment', quantity: -10, reason: 'use' }); // still low: no repeat
    await move({ kind: 'receipt', quantity: 5 }); // 85, still low: no repeat
    expect(await lowStockNotes(shop.biz.tenantId)).toHaveLength(2);
    const flagged = await withTenant(shop.biz.tenantId, (trx) => trx.selectFrom('inventory_items').select('low_stock_alerted_at').where('id', '=', dye.id).executeTakeFirstOrThrow());
    expect(flagged.low_stock_alerted_at).not.toBeNull();
    await move({ kind: 'receipt', quantity: 500 }); // restocked: 585 → marker cleared
    const cleared = await withTenant(shop.biz.tenantId, (trx) => trx.selectFrom('inventory_items').select('low_stock_alerted_at').where('id', '=', dye.id).executeTakeFirstOrThrow());
    expect(cleared.low_stock_alerted_at).toBeNull();
    await move({ kind: 'adjustment', quantity: -500, reason: 'spill' }); // 85: new crossing → new alert
    const second = await lowStockNotes(shop.biz.tenantId);
    expect(second).toHaveLength(4);
    expect(new Set(second.map((n) => n.dedupe_key)).size).toBe(2);
    expect(manager).toBeTruthy();
  });
});

describe('weekly digest', () => {
  it('builds once at the owner-chosen local day/hour, notifies in-app, and gates viewing', async () => {
    const shop = await liveShop('wahaj');
    const now = new Date();
    const local = DateTime.fromJSDate(now, { zone: 'Asia/Riyadh' });
    const bad = await shop.owner.call(digestSettings.PUT, { params: shop.p, body: { enabled: true, weekday: 9, hour: 9 } });
    expect(bad.status).toBe(422);
    const set = await shop.owner.call(digestSettings.PUT, { params: shop.p, body: { enabled: true, weekday: local.weekday % 7, hour: local.hour }, method: 'PUT' });
    expect(set.status).toBe(200);
    expect(set.body.data).toMatchObject({ enabled: true, weekday: local.weekday % 7, hour: local.hour, timezone: 'Asia/Riyadh' });
    // Data inside last week's window.
    const s = await staffWithHours(shop.biz, 'سارة');
    const svc = await service(shop.biz, 'صبغة', 30000);
    const cus = await customer(shop.biz);
    await booking(shop.biz, { customerId: cus, serviceId: svc, staffId: s, startsAt: todayAt('12:00', -2), status: 'completed', price: 30000 });
    await booking(shop.biz, { customerId: cus, serviceId: svc, staffId: s, startsAt: todayAt('12:00', 2), status: 'confirmed', price: 30000 });

    const made = await runDueDigests(now);
    const mine = await withTenant(shop.biz.tenantId, (trx) => trx.selectFrom('weekly_digests').selectAll().execute());
    expect(mine).toHaveLength(1);
    expect(made).toContain(mine[0]!.id);
    expect(await runDueDigests(now)).not.toContain(mine[0]!.id); // idempotent per week
    const note = await withTenant(shop.biz.tenantId, (trx) => trx.selectFrom('notifications').select(['target_path', 'kind']).where('kind', '=', 'business.weekly_digest').execute());
    expect(note).toHaveLength(1);
    expect(note[0]!.target_path).toBe(`/app/${shop.biz.slug}/digest/${mine[0]!.id}`);

    const list = await shop.owner.call(digests.GET, { params: shop.p });
    expect(list.body.data).toHaveLength(1);
    const one = (await shop.owner.call(digestOne.GET, { params: { ...shop.p, id: mine[0]!.id } })).body.data;
    expect(one.money).toBe(true);
    expect(one.payload.bookings.completed).toBe(1);
    expect(one.payload.revenue.completed_value_minor).toBe(30000);
    expect(one.payload.top_services[0]).toMatchObject({ bookings: 1, value_minor: 30000 });
    expect(one.payload.staff[0]).toMatchObject({ staff_id: s, completed: 1 });
    expect(one.payload.upcoming.bookings).toBe(1);

    const recep = await addMember(shop.owner, shop.biz.slug, 'receptionist');
    expect((await recep.call(digests.GET, { params: shop.p })).status).toBe(403);
    // Disabled → never due.
    await shop.owner.call(digestSettings.PUT, { params: shop.p, body: { enabled: false, weekday: 0, hour: 0 }, method: 'PUT' });
    const off = await withTenant(shop.biz.tenantId, (trx) => trx.selectFrom('tenant_settings').select('digest_enabled').executeTakeFirstOrThrow());
    expect(off.digest_enabled).toBe(false);
    // "Generate now" is idempotent per week.
    const gen = await shop.owner.call(digests.POST, { params: shop.p, body: {} });
    expect(gen.status).toBe(201);
    expect(gen.body.data.id).toBe(mine[0]!.id);
  });
});

describe('service badges', () => {
  it('owner sets a preset or custom badge; it reaches the public catalog', async () => {
    const shop = await liveShop('wahaj');
    const noText = await shop.owner.call(services.POST, { params: shop.p, body: { name_ar: 'بدون', price_minor: 1000, duration_min: 30, badge_kind: 'custom' } });
    expect(noText.status).toBe(422);
    const a = await shop.owner.call(services.POST, { params: shop.p, body: { name_ar: 'قص', price_minor: 1000, duration_min: 30, badge_kind: 'popular' } });
    expect(a.status).toBe(201);
    expect(a.body.data.badge_kind).toBe('popular');
    const b = await shop.owner.call(services.POST, { params: shop.p, body: { name_ar: 'صبغة', price_minor: 1000, duration_min: 30 } });
    const patched = await shop.owner.call(serviceOne.PATCH, { params: { ...shop.p, id: b.body.data.id }, body: { version: b.body.data.version, badge_kind: 'custom', badge_text_ar: 'حصري', badge_text_en: 'Exclusive' }, method: 'PATCH' });
    expect(patched.status).toBe(200);
    const cat = await withTenant(shop.biz.tenantId, (trx) => loadLiveCatalog(trx, shop.biz.tenantId, { productsEnabled: false }));
    expect(cat.services.find((s) => s.id === a.body.data.id)!.badge).toEqual({ kind: 'popular', text_ar: null, text_en: null });
    expect(cat.services.find((s) => s.id === b.body.data.id)!.badge).toEqual({ kind: 'custom', text_ar: 'حصري', text_en: 'Exclusive' });
    const cleared = await shop.owner.call(serviceOne.PATCH, { params: { ...shop.p, id: a.body.data.id }, body: { version: a.body.data.version, badge_kind: null }, method: 'PATCH' });
    expect(cleared.status).toBe(200);
    const cat2 = await withTenant(shop.biz.tenantId, (trx) => loadLiveCatalog(trx, shop.biz.tenantId, { productsEnabled: false }));
    expect(cat2.services.find((s) => s.id === a.body.data.id)!.badge).toBeNull();
  });
});

describe('image crop', () => {
  it('stores the cropped derivative with its crop rectangle; re-crop derives a new asset', async () => {
    const shop = await liveShop('wahaj');
    const png = await sharp({ create: { width: 800, height: 400, channels: 3, background: { r: 120, g: 40, b: 200 } } }).png().toBuffer();
    const upload = async (crop?: object) => {
      const fd = new FormData();
      fd.set('file', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'x.png');
      fd.set('purpose', 'logo');
      if (crop) fd.set('crop', JSON.stringify(crop));
      const req = new NextRequest('http://localhost:3000/api/x', { method: 'POST', body: fd, headers: { 'x-luma-csrf': '1', cookie: [...shop.owner.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } });
      const res = await assets.POST(req, { params: Promise.resolve(shop.p) });
      return { status: res.status, body: await res.json() };
    };
    const r = await upload({ x: 200, y: 50, width: 300, height: 300 });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ width: 300, height: 300, crop: { x: 200, y: 50, width: 300, height: 300 } });
    expect((await upload({ x: 0, y: 0, width: 2, height: 2 })).status).toBe(422);
    const plain = await upload();
    expect(plain.body.data).toMatchObject({ width: 800, height: 400, crop: null });
    const re = await shop.owner.call(assetCrop.POST, { params: { ...shop.p, id: plain.body.data.id }, body: { purpose: 'cover', crop: { x: 0, y: 100, width: 800, height: 200 } } });
    expect(re.status).toBe(201);
    expect(re.body.data).toMatchObject({ width: 800, height: 200 });
    const row = await withTenant(shop.biz.tenantId, (trx) => trx.selectFrom('assets').select(['source_asset_id', 'crop']).where('id', '=', re.body.data.id).executeTakeFirstOrThrow());
    expect(row.source_asset_id).toBe(plain.body.data.id);
    expect(row.crop).toEqual({ x: 0, y: 100, width: 800, height: 200 });
  });
});

describe('ZATCA status', () => {
  it('warns when no VAT number is configured', async () => {
    const shop = await liveShop('wahaj');
    expect((await shop.owner.call(zatca.GET, { params: shop.p })).body.data).toMatchObject({ vat_configured: false, phase: 1, phase2_compliance_claimed: false });
    await withTenant(shop.biz.tenantId, (trx) => trx.updateTable('tenant_settings').set({ tax_number: '310122393500003' }).execute());
    expect((await shop.owner.call(zatca.GET, { params: shop.p })).body.data.vat_configured).toBe(true);
  });
});
