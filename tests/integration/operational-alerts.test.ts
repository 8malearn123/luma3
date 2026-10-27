import { describe, expect, it } from 'vitest';
import { withSystem, withTenant } from '@/server/db/client';
import { runOpenBillsSweep } from '@/server/domains/finance/open-bills';
import { findStockMismatches, runStockBalanceCheck } from '@/server/domains/commerce/integrity';
import { addToCart, checkout, createProduct, liveShop } from '../helpers/commerce';
import { customer } from '../helpers/salon';
import * as items from '@/app/api/v1/t/[tenantSlug]/inventory/items/route';
import * as itemMoves from '@/app/api/v1/t/[tenantSlug]/inventory/items/[id]/movements/route';

const HOUR = 3_600_000;

async function visit(tenantId: string, branchId: string, v: { status: string; endedHoursAgo: number; total: number; paid: number }) {
  return withTenant(tenantId, async (trx) => {
    const tc = await trx.insertInto('tenant_customers').values({ tenant_id: tenantId, display_name: 'Noura', source: 'walk_in' }).returning('id').executeTakeFirstOrThrow();
    const end = new Date(Date.now() - v.endedHoursAgo * HOUR), start = new Date(end.getTime() - HOUR);
    const b = await trx.insertInto('bookings').values({
      tenant_id: tenantId, branch_id: branchId, number: `BKG-A${Math.floor(Math.random() * 1e9)}`, tenant_customer_id: tc.id, status: v.status, source: 'dashboard',
      starts_at: start, ends_at: end, timezone: 'Asia/Riyadh', subtotal_minor: v.total, total_minor: v.total, paid_minor: v.paid,
      payment_status: v.paid >= v.total ? 'paid' : v.paid > 0 ? 'partially_paid' : 'unpaid',
    }).returning('id').executeTakeFirstOrThrow();
    return b.id;
  });
}

const notes = (tenantId: string, kindPrefix: string) => withTenant(tenantId, (trx) => trx.selectFrom('notifications')
  .select(['kind', 'dedupe_key', 'target_path', 'body_ar']).where('kind', 'like', `${kindPrefix}%`).execute());

describe('unclosed bill alerts', () => {
  it('flags a completed visit with a balance due and an ended visit never completed, once each', async () => {
    const shop = await liveShop('wahaj');
    const { tenantId, branchId } = shop.biz;
    const later = new Date(Date.now() + 2 * HOUR); // past the grace periods for rows touched now
    const unpaid = await visit(tenantId, branchId, { status: 'completed', endedHoursAgo: 2, total: 30000, paid: 10000 });
    const open = await visit(tenantId, branchId, { status: 'in_service', endedHoursAgo: 2, total: 20000, paid: 0 });
    await visit(tenantId, branchId, { status: 'completed', endedHoursAgo: 2, total: 15000, paid: 15000 }); // settled
    await visit(tenantId, branchId, { status: 'checked_in', endedHoursAgo: -1, total: 15000, paid: 0 }); // still running
    await visit(tenantId, branchId, { status: 'completed', endedHoursAgo: 24 * 30, total: 15000, paid: 0 }); // old history

    await runOpenBillsSweep(later);
    await runOpenBillsSweep(later);
    const n = await notes(tenantId, 'finance.open_bill');
    expect(n.map((x) => x.dedupe_key).sort()).toEqual([`open_bill:not_closed:${open}`, `open_bill:unpaid:${unpaid}`].sort());
    const u = n.find((x) => x.kind === 'finance.open_bill.unpaid')!;
    expect(u.target_path).toBe(`/app/${shop.biz.slug}/bookings?booking=${unpaid}`);
    expect(u.body_ar).toContain('200');
  });
});

describe('stock balance alerts', () => {
  it('normal flows stay balanced; a cache edit that bypasses the ledger is flagged daily', async () => {
    const shop = await liveShop('wahaj');
    const { tenantId } = shop.biz;
    const product = await createProduct(shop.owner, shop.biz.slug);
    const buyer = await customer();
    await addToCart(buyer, shop.biz.slug, product.variants[0]!.id, 2);
    expect((await checkout(buyer, shop.biz.slug)).status).toBe(201); // active reservation of 2
    const dye = await shop.owner.call(items.POST, { params: shop.p, body: { name: 'صبغة', unit: 'ml', initial_quantity: 500 } });
    await shop.owner.call(itemMoves.POST, { params: { ...shop.p, id: dye.body.data.id }, body: { kind: 'adjustment', quantity: -40, reason: 'count' } });
    expect(await findStockMismatches(tenantId)).toEqual([]);

    await withSystem('test: edit stock outside the ledger', (trx) => trx.updateTable('inventory_items').set({ on_hand: 470 }).where('id', '=', dye.body.data.id).execute());
    await runStockBalanceCheck();
    await runStockBalanceCheck();
    const found = await findStockMismatches(tenantId);
    expect(found).toMatchObject([{ item_id: dye.body.data.id, on_hand: 470, ledger_on_hand: 460 }]);
    const n = await notes(tenantId, 'inventory.balance_mismatch');
    expect(n).toHaveLength(1);
    expect(n[0]!.target_path).toBe(`/app/${shop.biz.slug}/inventory?item=${dye.body.data.id}`);
  });
});
