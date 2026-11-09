import { describe, expect, it } from 'vitest';
import { withSystem, withTenant } from '@/server/db/client';
import { findStockMismatches } from '@/server/domains/commerce/integrity';
import { findIdleItems, runIdleStockCheck } from '@/server/domains/commerce/idle';
import { addMember, addToCart, checkout, createProduct, liveShop, movements, stock } from '../helpers/commerce';
import { customer } from '../helpers/salon';
import * as items from '@/app/api/v1/t/[tenantSlug]/inventory/items/route';
import * as itemMoves from '@/app/api/v1/t/[tenantSlug]/inventory/items/[id]/movements/route';
import * as recipe from '@/app/api/v1/t/[tenantSlug]/inventory/recipes/[serviceId]/route';
import * as services from '@/app/api/v1/t/[tenantSlug]/services/route';
import * as counts from '@/app/api/v1/t/[tenantSlug]/inventory/counts/route';
import * as countOne from '@/app/api/v1/t/[tenantSlug]/inventory/counts/[id]/route';
import * as countApply from '@/app/api/v1/t/[tenantSlug]/inventory/counts/[id]/apply/route';
import * as countCancel from '@/app/api/v1/t/[tenantSlug]/inventory/counts/[id]/cancel/route';

async function setup() {
  const shop = await liveShop('wahaj');
  const dye = (await shop.owner.call(items.POST, { params: shop.p, body: { name: 'صبغة', unit: 'ml', initial_quantity: 500, cost_per_unit_minor: 30 } })).body.data;
  const gloves = (await shop.owner.call(items.POST, { params: shop.p, body: { name: 'قفازات', unit: 'piece', initial_quantity: 3 } })).body.data;
  const product = await createProduct(shop.owner, shop.biz.slug);
  return { ...shop, dye, gloves, product, productItem: product.variants[0]!.inventory_item_id };
}

const variance = (tenantId: string) => withTenant(tenantId, (trx) => trx.selectFrom('notifications').select(['user_id', 'title_ar', 'target_path', 'data'])
  .where('kind', '=', 'inventory.count_variance').execute());

describe('physical stock count', () => {
  it('draft → enter quantities → apply once: differences become adjustments read at apply time, and notify', async () => {
    const s = await setup();
    const created = await s.owner.call(counts.POST, { params: s.p, body: { kind: 'all' } });
    expect(created.status).toBe(201);
    const id = created.body.data.id as string;
    expect((await s.owner.call(counts.POST, { params: s.p, body: {} })).body.error.code).toBe('count_in_progress');
    const recep = await addMember(s.owner, s.biz.slug, 'receptionist');
    expect((await recep.call(countOne.PATCH, { params: { ...s.p, id }, body: { version: 1, lines: [] } })).status).toBe(403);

    const draft = (await s.owner.call(countOne.GET, { params: { ...s.p, id } })).body.data;
    expect(draft.lines.map((l: any) => l.inventory_item_id).sort()).toEqual([s.dye.id, s.gloves.id, s.productItem].sort());
    expect(draft.summary).toMatchObject({ lines: 3, counted: 0, uncounted: 3 });

    const half = await s.owner.call(countOne.PATCH, { params: { ...s.p, id }, body: { version: 1, lines: [{ inventory_item_id: s.gloves.id, counted_quantity: 2.5 }] } });
    expect(half.body.error.code).toBe('whole_units_required');
    const saved = await s.owner.call(countOne.PATCH, { params: { ...s.p, id }, body: { version: 1, lines: [{ inventory_item_id: s.dye.id, counted_quantity: 480 }, { inventory_item_id: s.gloves.id, counted_quantity: 3 }] } });
    expect(saved.status).toBe(200);
    expect(saved.body.data.summary).toMatchObject({ counted: 2, uncounted: 1 });
    expect((await s.owner.call(countOne.PATCH, { params: { ...s.p, id }, body: { version: 1, lines: [] } })).body.error.code).toBe('version_conflict');

    // Used while counting: the system quantity is read when the count is applied.
    await s.owner.call(itemMoves.POST, { params: { ...s.p, id: s.dye.id }, body: { kind: 'adjustment', quantity: -10, reason: 'spill' } });
    const applied = await s.owner.call(countApply.POST, { params: { ...s.p, id }, body: { version: 2 } });
    expect(applied.status).toBe(200);
    expect(applied.body.data.status).toBe('applied');
    const dyeLine = applied.body.data.lines.find((l: any) => l.inventory_item_id === s.dye.id);
    expect(dyeLine).toMatchObject({ system_quantity: 490, counted_quantity: 480, variance: -10, variance_cost_minor: -300, flagged: true });
    expect(applied.body.data.lines.find((l: any) => l.inventory_item_id === s.gloves.id)).toMatchObject({ variance: 0, flagged: false });
    expect(await stock(s.biz.tenantId, s.dye.id)).toEqual({ on_hand: 480, reserved: 0 });
    expect(await stock(s.biz.tenantId, s.productItem)).toEqual({ on_hand: 5, reserved: 0 }); // not counted → unchanged
    expect((await movements(s.biz.tenantId, s.dye.id)).filter((m) => m.ref_type === 'stock_count')).toEqual([{ kind: 'adjustment', quantity: -10, ref_type: 'stock_count', ref_id: id }]);
    expect(await findStockMismatches(s.biz.tenantId)).toEqual([]);

    const n = await variance(s.biz.tenantId);
    expect(n).toHaveLength(1); // owner only; the receptionist cannot manage inventory
    expect(n[0]!.target_path).toBe(`/app/${s.biz.slug}/inventory?tab=counts&count=${id}`);
    expect(n[0]!.data).toMatchObject({ flagged: 1, shortages: 1, surpluses: 0 });

    expect((await s.owner.call(countApply.POST, { params: { ...s.p, id }, body: { version: 3 } })).body.error.code).toBe('count_closed');
    expect((await s.owner.call(counts.POST, { params: s.p, body: {} })).status).toBe(201); // the branch is free again
  });

  it('tolerance only flags differences above it; a count below reserved stock is refused; drafts can be cancelled', async () => {
    const s = await setup();
    const buyer = await customer();
    await addToCart(buyer, s.biz.slug, s.product.variants[0]!.id, 2);
    expect((await checkout(buyer, s.biz.slug)).status).toBe(201);

    const c1 = (await s.owner.call(counts.POST, { params: s.p, body: { tolerance_pct: 5 } })).body.data.id;
    await s.owner.call(countOne.PATCH, { params: { ...s.p, id: c1 }, body: { version: 1, lines: [{ inventory_item_id: s.productItem, counted_quantity: 1 }] } });
    const refused = await s.owner.call(countApply.POST, { params: { ...s.p, id: c1 }, body: { version: 2 } });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('counted_below_reserved');
    expect(await stock(s.biz.tenantId, s.productItem)).toEqual({ on_hand: 5, reserved: 2 });

    await s.owner.call(countOne.PATCH, { params: { ...s.p, id: c1 }, body: { version: 2, lines: [
      { inventory_item_id: s.productItem, counted_quantity: null },
      { inventory_item_id: s.dye.id, counted_quantity: 490 }, // −2% → within 5%
      { inventory_item_id: s.gloves.id, counted_quantity: 2 }, // −33%
    ] } });
    const applied = (await s.owner.call(countApply.POST, { params: { ...s.p, id: c1 }, body: { version: 3 } })).body.data;
    expect(applied.summary).toMatchObject({ counted: 2, shortages: 2, flagged: 1 });
    expect(await stock(s.biz.tenantId, s.dye.id)).toEqual({ on_hand: 490, reserved: 0 });
    const n = await variance(s.biz.tenantId);
    expect(n[0]!.data).toMatchObject({ flagged: 1 });

    const c2 = (await s.owner.call(counts.POST, { params: s.p, body: { kind: 'material' } })).body.data.id;
    expect((await s.owner.call(countOne.GET, { params: { ...s.p, id: c2 } })).body.data.lines).toHaveLength(2);
    expect((await s.owner.call(countCancel.POST, { params: { ...s.p, id: c2 } })).body.data.status).toBe('cancelled');
    const list = (await s.owner.call(counts.GET, { params: s.p })).body.data;
    expect(list.map((c: any) => c.status)).toEqual(['cancelled', 'applied']);
  });
});

describe('items not drawn from stock', () => {
  it('flags stocked items with no sale or consumption in 30 days, with the likely cause, in one weekly digest', async () => {
    const s = await setup();
    const old = new Date(Date.now() - 40 * 86_400_000);
    await withSystem('test: age the items', (trx) => trx.updateTable('inventory_items').set({ created_at: old }).where('tenant_id', '=', s.biz.tenantId).execute());
    const svc = await s.owner.call(services.POST, { params: s.p, body: { name_ar: 'صبغة', price_minor: 30000, duration_min: 90 } });
    await s.owner.call(recipe.PUT, { params: { ...s.p, serviceId: svc.body.data.id }, body: { lines: [{ inventory_item_id: s.gloves.id, quantity: 1, unit: 'piece' }] } });

    const reasons = Object.fromEntries((await findIdleItems(new Date(), s.biz.tenantId)).map((i) => [i.item_id, i.reason]));
    expect(reasons).toEqual({ [s.dye.id]: 'no_recipe', [s.gloves.id]: 'not_consumed', [s.productItem]: 'not_sold' });
    const listed = await s.owner.call(items.GET, { params: s.p, query: { idle: '1' } });
    expect(listed.body.data.items.find((i: any) => i.id === s.dye.id).idle_reason).toBe('no_recipe');

    // A recent consumption means the item is being drawn from.
    await withTenant(s.biz.tenantId, (trx) => trx.insertInto('stock_movements').values({
      tenant_id: s.biz.tenantId, inventory_item_id: s.gloves.id, kind: 'consumption', quantity: -1, on_hand_after: 2, reserved_after: 0,
    }).execute());
    await withSystem('test: keep cache in step', (trx) => trx.updateTable('inventory_items').set({ on_hand: 2 }).where('id', '=', s.gloves.id).execute());
    expect((await findIdleItems(new Date(), s.biz.tenantId)).map((i) => i.item_id)).not.toContain(s.gloves.id);

    await runIdleStockCheck();
    await runIdleStockCheck();
    const n = await withTenant(s.biz.tenantId, (trx) => trx.selectFrom('notifications').select(['title_ar', 'body_ar', 'target_path']).where('kind', '=', 'inventory.idle_stock').execute());
    expect(n).toHaveLength(1);
    expect(n[0]!.title_ar).toContain('2');
    expect(n[0]!.body_ar).toContain('غير مرتبطة بوصفة');
    expect(n[0]!.target_path).toBe(`/app/${s.biz.slug}/inventory?idle=1`);
  });
});
