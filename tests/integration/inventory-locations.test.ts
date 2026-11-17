import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { withTenant } from '@/server/db/client';
import { consumeMaterialsForBookingItem, markOrderPaid } from '@/server/domains/commerce';
import { findStockMismatches } from '@/server/domains/commerce/integrity';
import { addMember, addToCart, checkout, createProduct, liveShop } from '../helpers/commerce';
import { customer } from '../helpers/salon';
import * as items from '@/app/api/v1/t/[tenantSlug]/inventory/items/route';
import * as itemOne from '@/app/api/v1/t/[tenantSlug]/inventory/items/[id]/route';
import * as itemMoves from '@/app/api/v1/t/[tenantSlug]/inventory/items/[id]/movements/route';
import * as locations from '@/app/api/v1/t/[tenantSlug]/inventory/locations/route';
import * as locationOne from '@/app/api/v1/t/[tenantSlug]/inventory/locations/[id]/route';
import * as settings from '@/app/api/v1/t/[tenantSlug]/inventory/settings/route';
import * as balances from '@/app/api/v1/t/[tenantSlug]/inventory/balances/route';
import * as transfers from '@/app/api/v1/t/[tenantSlug]/inventory/transfers/route';
import * as transferOne from '@/app/api/v1/t/[tenantSlug]/inventory/transfers/[id]/route';
import * as transferReceive from '@/app/api/v1/t/[tenantSlug]/inventory/transfers/[id]/receive/route';
import * as reverse from '@/app/api/v1/t/[tenantSlug]/inventory/movements/[id]/reverse/route';
import * as issue from '@/app/api/v1/t/[tenantSlug]/inventory/issue/route';
import * as tasks from '@/app/api/v1/t/[tenantSlug]/inventory/tasks/route';
import * as taskOne from '@/app/api/v1/t/[tenantSlug]/inventory/tasks/[id]/route';
import * as consumptions from '@/app/api/v1/t/[tenantSlug]/inventory/consumptions/route';
import * as consumptionOne from '@/app/api/v1/t/[tenantSlug]/inventory/consumptions/[id]/route';
import * as reports from '@/app/api/v1/t/[tenantSlug]/inventory/reports/[kind]/route';
import * as recipe from '@/app/api/v1/t/[tenantSlug]/inventory/recipes/[serviceId]/route';
import * as services from '@/app/api/v1/t/[tenantSlug]/services/route';
import * as staff from '@/app/api/v1/t/[tenantSlug]/staff/route';
import * as suppliers from '@/app/api/v1/t/[tenantSlug]/purchasing/suppliers/route';
import * as receipts from '@/app/api/v1/t/[tenantSlug]/purchasing/receipts/route';
import * as invoices from '@/app/api/v1/t/[tenantSlug]/purchasing/invoices/route';
import * as invoiceLinks from '@/app/api/v1/t/[tenantSlug]/purchasing/invoices/[id]/links/route';
import * as invoicePost from '@/app/api/v1/t/[tenantSlug]/purchasing/invoices/[id]/post/route';
import * as payments from '@/app/api/v1/t/[tenantSlug]/purchasing/payments/route';
import * as financeReport from '@/app/api/v1/t/[tenantSlug]/finance/report/route';
import * as changePlan from '@/app/api/v1/t/[tenantSlug]/subscription/change-plan/route';

type Shop = Awaited<ReturnType<typeof liveShop>>;

async function shop(plan: 'wahaj' | 'fareed' = 'fareed') {
  const s = await liveShop(plan);
  const locs = (await s.owner.call(locations.GET, { params: s.p })).body.data as any[];
  const main = locs.find((l) => l.is_default)!;
  return { ...s, main: main.id as string };
}

async function material(s: Shop, body: Record<string, unknown> = {}) {
  const r = await s.owner.call(items.POST, { params: s.p, body: { name: `مادة ${randomUUID().slice(0, 4)}`, unit: 'ml', ...body } });
  expect(r.status).toBe(201);
  return r.body.data.id as string;
}

async function station(s: Shop & { main: string }, name = 'كرسي 3', extra: Record<string, unknown> = {}) {
  const r = await s.owner.call(locations.POST, { params: s.p, body: { kind: 'station', name, ...extra } });
  expect(r.status).toBe(201);
  return r.body.data.id as string;
}

async function bal(s: Shop, itemId: string) {
  const r = await s.owner.call(balances.GET, { params: s.p, query: { inventory_item_id: itemId } });
  return Object.fromEntries((r.body.data.items as any[]).map((b) => [b.location_id, { on_hand: b.on_hand, in_transit: b.in_transit, available: b.available }]));
}

async function onHand(tenantId: string, itemId: string) {
  return withTenant(tenantId, async (trx) => Number((await trx.selectFrom('inventory_items').select('on_hand').where('id', '=', itemId).executeTakeFirstOrThrow()).on_hand));
}

async function journal(tenantId: string, refType: string, refId?: string) {
  return withTenant(tenantId, (trx) => {
    let q = trx.selectFrom('financial_entries').select(['entry_group_id', 'account', 'debit_minor', 'credit_minor']).where('ref_type', '=', refType);
    if (refId) q = q.where('ref_id', '=', refId);
    return q.orderBy('account').execute();
  });
}

function balanced(rows: Array<{ entry_group_id: string; debit_minor: number; credit_minor: number }>) {
  const g = new Map<string, number>();
  for (const r of rows) g.set(r.entry_group_id, (g.get(r.entry_group_id) ?? 0) + r.debit_minor - r.credit_minor);
  return [...g.values()].every((v) => v === 0);
}

async function chairBooking(s: Shop & { main: string }, serviceId: string, staffId: string, resourceId: string) {
  const tenantId = s.biz.tenantId;
  return withTenant(tenantId, async (trx) => {
    const tc = await trx.insertInto('tenant_customers').values({ tenant_id: tenantId, display_name: 'Walk-in', source: 'walk_in' }).returning('id').executeTakeFirstOrThrow();
    const start = new Date(Date.now() + 86_400_000 + Math.floor(Math.random() * 1e8)), end = new Date(start.getTime() + 60 * 60_000);
    const b = await trx.insertInto('bookings').values({
      tenant_id: tenantId, branch_id: s.biz.branchId, number: `BKG-T${Math.floor(Math.random() * 1e9)}`, tenant_customer_id: tc.id, status: 'completed', source: 'dashboard',
      starts_at: start, ends_at: end, timezone: 'Asia/Riyadh', subtotal_minor: 10000, total_minor: 10000,
    }).returning('id').executeTakeFirstOrThrow();
    const bi = await trx.insertInto('booking_items').values({
      tenant_id: tenantId, booking_id: b.id, sequence: 1, service_id: serviceId, staff_id: staffId, starts_at: start, ends_at: end,
      staff_name: 'S', duration_min: 60, unit_price_minor: 10000, line_total_minor: 10000,
    }).returning('id').executeTakeFirstOrThrow();
    await trx.insertInto('booking_allocations').values({
      tenant_id: tenantId, booking_id: b.id, booking_item_id: bi.id, resource_id: resourceId, during: `[${start.toISOString()},${end.toISOString()})`, state: 'confirmed',
    }).execute();
    return bi.id;
  });
}

async function chair(s: Shop) {
  return withTenant(s.biz.tenantId, async (trx) => {
    const rt = await trx.insertInto('resource_types').values({ tenant_id: s.biz.tenantId, name_ar: 'كرسي' }).returning('id').executeTakeFirstOrThrow();
    const r = await trx.insertInto('resources').values({ tenant_id: s.biz.tenantId, branch_id: s.biz.branchId, resource_type_id: rt.id, name: 'كرسي 3' }).returning('id').executeTakeFirstOrThrow();
    return r.id;
  });
}

describe('stock locations and transfers', () => {
  it('each branch has a default main location; a transfer keeps the total and moves the distribution (20 → 18 + 2)', async () => {
    const s = await shop();
    const dye = await material(s, { initial_quantity: 20, cost_per_unit_minor: 50 });
    const st = await station(s);
    const t = await s.owner.call(transfers.POST, { params: s.p, body: { from_location_id: s.main, to_location_id: st, lines: [{ inventory_item_id: dye, quantity: 2 }] }, idempotencyKey: true });
    expect(t.status).toBe(201);
    expect(t.body.data).toMatchObject({ status: 'completed', mode: 'immediate' });
    expect(t.body.data.number).toMatch(/^TRF-\d{6}$/);
    expect(t.body.data.lines[0]).toMatchObject({ quantity: 2, unit_cost_minor: 50, total_cost_minor: 100 });
    const b = await bal(s, dye);
    expect(b[s.main]!.on_hand).toBe(18);
    expect(b[st]!.on_hand).toBe(2);
    expect(await onHand(s.biz.tenantId, dye)).toBe(20);
    // Transfers post nothing to the journal.
    const tm = await withTenant(s.biz.tenantId, (trx) => trx.selectFrom('stock_movements').select('id').where('document_id', '=', t.body.data.id).execute());
    expect(tm).toHaveLength(2);
    expect(await withTenant(s.biz.tenantId, (trx) => trx.selectFrom('financial_entries').select('id').where('ref_id', 'in', tm.map((m) => m.id)).execute())).toEqual([]);
    // Not enough stock → nothing moves.
    const tooMuch = await s.owner.call(transfers.POST, { params: s.p, body: { from_location_id: st, to_location_id: s.main, lines: [{ inventory_item_id: dye, quantity: 3 }] }, idempotencyKey: true });
    expect(tooMuch.status).toBe(409);
    expect((await bal(s, dye))[st]!.on_hand).toBe(2);
    expect(await findStockMismatches(s.biz.tenantId)).toEqual([]);
  });

  it('resubmitting with the same Idempotency-Key replays the transfer instead of moving stock twice', async () => {
    const s = await shop();
    const dye = await material(s, { initial_quantity: 20 });
    const st = await station(s);
    const body = { from_location_id: s.main, to_location_id: st, lines: [{ inventory_item_id: dye, quantity: 2 }] };
    const key = `trf-${randomUUID()}`;
    const a = await s.owner.call(transfers.POST, { params: s.p, body, idempotencyKey: key });
    const b = await s.owner.call(transfers.POST, { params: s.p, body, idempotencyKey: key });
    expect(b.status).toBe(201);
    expect(b.body.data.id).toBe(a.body.data.id);
    expect((await bal(s, dye))[s.main]!.on_hand).toBe(18);
    expect((await s.owner.call(transfers.POST, { params: s.p, body: { ...body, note: 'x' }, idempotencyKey: key })).status).toBe(422);
    expect((await s.owner.call(transfers.POST, { params: s.p, body })).body.error.code).toBe('idempotency_key_required');
  });

  it('confirm-receipt mode: in-transit stock is available in neither location until received', async () => {
    const s = await shop();
    expect((await s.owner.call(settings.PUT, { params: s.p, body: { transfer_confirmation: 'confirm_receipt' } })).status).toBe(200);
    const dye = await material(s, { initial_quantity: 20 });
    const st = await station(s);
    const t = await s.owner.call(transfers.POST, { params: s.p, body: { from_location_id: s.main, to_location_id: st, lines: [{ inventory_item_id: dye, quantity: 2 }] }, idempotencyKey: true });
    expect(t.body.data.status).toBe('in_transit');
    const b = await bal(s, dye);
    expect(b[s.main]).toMatchObject({ on_hand: 18, available: 18 });
    expect(b[st]).toMatchObject({ on_hand: 0, in_transit: 2, available: 0 });
    // Neither the destination nor the source can issue the in-transit quantity.
    expect((await s.owner.call(issue.POST, { params: s.p, body: { inventory_item_id: dye, location_id: st, quantity: 1, reason: 'test use' }, idempotencyKey: true })).status).toBe(409);
    expect((await s.owner.call(issue.POST, { params: s.p, body: { inventory_item_id: dye, location_id: s.main, quantity: 19, reason: 'test use' }, idempotencyKey: true })).status).toBe(409);
    const r = await s.owner.call(transferReceive.POST, { params: { ...s.p, id: t.body.data.id }, body: {} });
    expect(r.body.data.status).toBe('completed');
    expect((await bal(s, dye))[st]).toMatchObject({ on_hand: 2, in_transit: 0 });
    expect(await onHand(s.biz.tenantId, dye)).toBe(20);
    expect((await s.owner.call(transferReceive.POST, { params: { ...s.p, id: t.body.data.id }, body: {} })).body.error.code).toBe('transfer_not_in_transit');
    expect(await findStockMismatches(s.biz.tenantId)).toEqual([]);
  });
});

describe('costing (weighted average, D15)', () => {
  it('receipts re-average; issues use the average; later cost edits never change past movements', async () => {
    const s = await shop();
    const dye = await material(s);
    await s.owner.call(itemMoves.POST, { params: { ...s.p, id: dye }, body: { kind: 'receipt', quantity: 10, unit_cost_minor: 100 } });
    await s.owner.call(itemMoves.POST, { params: { ...s.p, id: dye }, body: { kind: 'receipt', quantity: 10, unit_cost_minor: 200 } });
    const item = (await s.owner.call(itemOne.GET, { params: { ...s.p, id: dye } })).body.data;
    expect(item).toMatchObject({ avg_cost_minor: 150, stock_value_minor: 3000, on_hand: 20 });
    // 1 l at 100 per l = 0.1 per ml.
    const issued = await s.owner.call(issue.POST, { params: s.p, body: { inventory_item_id: dye, quantity: 5, reason: 'training' }, idempotencyKey: true });
    expect(issued.body.data.total_cost_minor).toBe(750);
    const hist = (await s.owner.call(itemMoves.GET, { params: { ...s.p, id: dye } })).body.data.items as any[];
    const cons = hist.find((m) => m.kind === 'consumption');
    expect(cons).toMatchObject({ unit_cost_minor: 150, total_cost_minor: -750 });
    await s.owner.call(itemOne.PATCH, { params: { ...s.p, id: dye }, body: { cost_per_unit_minor: 999 } });
    await s.owner.call(itemMoves.POST, { params: { ...s.p, id: dye }, body: { kind: 'receipt', quantity: 5, unit_cost_minor: 300 } });
    const after = (await s.owner.call(itemMoves.GET, { params: { ...s.p, id: dye } })).body.data.items as any[];
    expect(after.find((m) => m.id === cons.id)).toMatchObject({ unit_cost_minor: 150, total_cost_minor: -750 });
    // (15 × 150 + 5 × 300) / 20 = 187.5
    expect((await s.owner.call(itemOne.GET, { params: { ...s.p, id: dye } })).body.data.avg_cost_minor).toBe(187.5);
    // Receptionists never see costs.
    const recep = await addMember(s.owner, s.biz.slug, 'receptionist');
    const rh = (await recep.call(itemMoves.GET, { params: { ...s.p, id: dye } })).body.data.items[0];
    expect(rh).not.toHaveProperty('unit_cost_minor');
  });

  it('waste needs a reason and posts shrinkage; a mistaken receipt is reversed by a correction, never edited', async () => {
    const s = await shop();
    const dye = await material(s, { initial_quantity: 100, cost_per_unit_minor: 10 });
    expect((await s.owner.call(itemMoves.POST, { params: { ...s.p, id: dye }, body: { kind: 'waste', quantity: 5 } })).status).toBe(422);
    const w = await s.owner.call(itemMoves.POST, { params: { ...s.p, id: dye }, body: { kind: 'waste', quantity: 5, reason: 'bottle broke' } });
    expect(w.status).toBe(201);
    expect(w.body.data.on_hand).toBe(95);
    const mv = await withTenant(s.biz.tenantId, (trx) => trx.selectFrom('stock_movements').select(['id', 'kind']).where('inventory_item_id', '=', dye).where('kind', '=', 'waste').executeTakeFirstOrThrow());
    const j = await journal(s.biz.tenantId, 'stock_movement', mv.id);
    expect(j.map((r) => [r.account, r.debit_minor, r.credit_minor])).toEqual([['inventory', 0, 50], ['inventory_shrinkage', 50, 0]]);
    // Reversal of a receipt.
    await s.owner.call(itemMoves.POST, { params: { ...s.p, id: dye }, body: { kind: 'receipt', quantity: 10, unit_cost_minor: 10 } });
    const rec = await withTenant(s.biz.tenantId, (trx) => trx.selectFrom('stock_movements').select('id').where('inventory_item_id', '=', dye).where('kind', '=', 'receipt').executeTakeFirstOrThrow());
    const rv = await s.owner.call(reverse.POST, { params: { ...s.p, id: rec.id }, body: { reason: 'entered twice' } });
    expect(rv.status).toBe(201);
    expect(rv.body.data.on_hand).toBe(95);
    expect((await s.owner.call(reverse.POST, { params: { ...s.p, id: rec.id }, body: { reason: 'again' } })).body.error.code).toBe('already_reversed');
    const rj = await journal(s.biz.tenantId, 'stock_movement', rv.body.data.id);
    expect(rj.map((r) => [r.account, r.debit_minor, r.credit_minor])).toEqual([['goods_received_not_invoiced', 100, 0], ['inventory', 0, 100]]);
  });
});

describe('service consumption from the chair station', () => {
  async function setup() {
    const s = await shop();
    const svc = await s.owner.call(services.POST, { params: s.p, body: { name_ar: 'صبغة', price_minor: 10000, duration_min: 60 } });
    const sp = await s.owner.call(staff.POST, { params: s.p, body: { display_name: 'Specialist' } });
    const dye = await material(s, { initial_quantity: 100, cost_per_unit_minor: 20 });
    await s.owner.call(recipe.PUT, { params: { ...s.p, serviceId: svc.body.data.id }, body: { lines: [{ inventory_item_id: dye, quantity: 30, unit: 'ml' }] } });
    const res = await chair(s);
    const st = await station(s, 'محطة كرسي 3', { resource_ids: [res] });
    return { ...s, serviceId: svc.body.data.id as string, staffId: sp.body.data.id as string, dye, res, st };
  }

  it('deducts once from the station serving the booked chair and posts material cost', async () => {
    const s = await setup();
    await s.owner.call(transfers.POST, { params: s.p, body: { from_location_id: s.main, to_location_id: s.st, lines: [{ inventory_item_id: s.dye, quantity: 50 }] }, idempotencyKey: true });
    const bi = await chairBooking(s, s.serviceId, s.staffId, s.res);
    const r1 = await withTenant(s.biz.tenantId, (trx) => consumeMaterialsForBookingItem(trx, s.biz.tenantId, bi, null));
    expect(r1.consumed).toEqual([{ inventoryItemId: s.dye, quantity: 30, unit: 'ml' }]);
    const r2 = await withTenant(s.biz.tenantId, (trx) => consumeMaterialsForBookingItem(trx, s.biz.tenantId, bi, null));
    expect(r2.skipped).toBe('already_consumed');
    const b = await bal(s, s.dye);
    expect(b[s.st]!.on_hand).toBe(20);
    expect(b[s.main]!.on_hand).toBe(50);
    const rows = (await s.owner.call(consumptions.GET, { params: s.p, query: { booking_item_id: bi } })).body.data;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ location_id: s.st, expected_qty: 30, actual_qty: 30, posted_qty: 30, status: 'posted', total_cost_minor: 600, chair_name: 'كرسي 3' });
    const mv = await withTenant(s.biz.tenantId, (trx) => trx.selectFrom('stock_movements').select('id').where('ref_id', '=', bi).where('kind', '=', 'consumption').execute());
    expect(mv).toHaveLength(1);
    const j = await journal(s.biz.tenantId, 'stock_movement', mv[0]!.id);
    expect(j.map((r) => [r.account, r.debit_minor, r.credit_minor])).toEqual([['inventory', 0, 600], ['material_costs', 600, 0]]);
    // Correcting actual usage posts only the difference (5 ml back to the station).
    const fix = await s.owner.call(consumptionOne.PATCH, { params: { ...s.p, id: rows[0].id }, body: { actual_qty: 25, reason: 'used less', version: rows[0].version } });
    expect(fix.status).toBe(200);
    expect(fix.body.data).toMatchObject({ actual_qty: 25, posted_qty: 25 });
    expect((await bal(s, s.dye))[s.st]!.on_hand).toBe(25);
    const rep = await s.owner.call(reports.GET, { params: { ...s.p, kind: 'expected_vs_actual' } });
    expect(rep.body.data.items[0]).toMatchObject({ expected_qty: 30, actual_qty: 25, difference: -5 });
    expect(rep.body.data.usage_note).toMatch(/performance/);
  });

  it('shortage at the station: no negative stock, the missing quantity is kept on a task and posted later', async () => {
    const s = await setup();
    await s.owner.call(transfers.POST, { params: s.p, body: { from_location_id: s.main, to_location_id: s.st, lines: [{ inventory_item_id: s.dye, quantity: 10 }] }, idempotencyKey: true });
    const bi = await chairBooking(s, s.serviceId, s.staffId, s.res);
    const r = await withTenant(s.biz.tenantId, (trx) => consumeMaterialsForBookingItem(trx, s.biz.tenantId, bi, null));
    expect(r.shortages).toEqual([{ inventoryItemId: s.dye, required: 30, consumed: 10, unit: 'ml' }]);
    expect((await bal(s, s.dye))[s.st]!.on_hand).toBe(0);
    const open = (await s.owner.call(tasks.GET, { params: s.p, query: { status: 'open', kind: 'shortage' } })).body.data;
    expect(open).toHaveLength(1);
    expect(open[0].payload).toMatchObject({ required: 30, consumed: 10, missing: 20 });
    // Nothing yet at the station: still short.
    const tryNow = await s.owner.call(taskOne.POST, { params: { ...s.p, id: open[0].id }, body: { action: 'post_remaining' } });
    expect(tryNow.body.data).toMatchObject({ status: 'open', remaining: 20 });
    await s.owner.call(transfers.POST, { params: s.p, body: { from_location_id: s.main, to_location_id: s.st, lines: [{ inventory_item_id: s.dye, quantity: 20 }] }, idempotencyKey: true });
    const done = await s.owner.call(taskOne.POST, { params: { ...s.p, id: open[0].id }, body: { action: 'post_remaining' } });
    expect(done.body.data).toMatchObject({ status: 'resolved', remaining: 0 });
    const row = (await s.owner.call(consumptions.GET, { params: s.p, query: { booking_item_id: bi } })).body.data[0];
    expect(row).toMatchObject({ posted_qty: 30, shortage_qty: 0, status: 'posted' });
    expect(await findStockMismatches(s.biz.tenantId)).toEqual([]);
  });
});

describe('purchasing and accounts payable', () => {
  it('receipt adds stock once; linking an invoice adds nothing; invoice and payment post balanced entries; payment is idempotent', async () => {
    const s = await shop();
    const dye = await material(s, { storage_unit: 'bottle', conversion_factor: 500 });
    const sup = (await s.owner.call(suppliers.POST, { params: s.p, body: { name: 'مورد الألوان' } })).body.data;
    const key = `rcv-${randomUUID()}`;
    const body = { supplier_id: sup.id, received_on: '2026-11-01', post: true, lines: [{ inventory_item_id: dye, quantity: 2, uom: 'storage', unit_cost_minor: 50000 }] };
    const rc = await s.owner.call(receipts.POST, { params: s.p, body, idempotencyKey: key });
    expect(rc.status).toBe(201);
    expect(rc.body.data.number).toMatch(/^RCV-/);
    expect(rc.body.data.lines[0]).toMatchObject({ quantity: 1000, unit_cost_minor: 100, not_invoiced_qty: 1000 });
    expect((await s.owner.call(receipts.POST, { params: s.p, body, idempotencyKey: key })).body.data.id).toBe(rc.body.data.id);
    expect(await onHand(s.biz.tenantId, dye)).toBe(1000);
    const notInvoiced = (await s.owner.call(receipts.GET, { params: s.p, query: { not_invoiced: '1' } })).body.data;
    expect(notInvoiced.map((r: any) => r.id)).toEqual([rc.body.data.id]);
    const recvMv = await withTenant(s.biz.tenantId, (trx) => trx.selectFrom('stock_movements').select('id').where('document_id', '=', rc.body.data.id).executeTakeFirstOrThrow());
    expect((await journal(s.biz.tenantId, 'stock_movement', recvMv.id)).map((r) => [r.account, r.debit_minor, r.credit_minor]))
      .toEqual([['goods_received_not_invoiced', 0, 100000], ['inventory', 100000, 0]]);

    // Invoice at 110 per ml for 1000 ml, partly matched first, then fully; tax 16500.
    const inv = await s.owner.call(invoices.POST, { params: s.p, body: {
      supplier_id: sup.id, invoice_number: 'INV-77', invoice_date: '2026-11-02',
      lines: [{ inventory_item_id: dye, quantity: 1000, unit_cost_minor: 110, tax_minor: 16500, links: [{ receipt_line_id: rc.body.data.lines[0].id, quantity: 400 }] }],
    } });
    expect(inv.status).toBe(201);
    expect(inv.body.data).toMatchObject({ total_minor: 126500, matching: 'partly_matched', status: 'draft' });
    const linked = await s.owner.call(invoiceLinks.POST, { params: { ...s.p, id: inv.body.data.id }, body: { invoice_line_id: inv.body.data.lines[0].id, receipt_line_id: rc.body.data.lines[0].id, quantity: 1000 } });
    expect(linked.body.data.matching).toBe('matched');
    expect((await s.owner.call(invoiceLinks.POST, { params: { ...s.p, id: inv.body.data.id }, body: { invoice_line_id: inv.body.data.lines[0].id, receipt_line_id: rc.body.data.lines[0].id, quantity: 1001 } })).status).toBe(422);
    expect(await onHand(s.biz.tenantId, dye)).toBe(1000); // linking never adds stock
    expect((await s.owner.call(invoices.POST, { params: s.p, body: { supplier_id: sup.id, invoice_number: 'inv-77', invoice_date: '2026-11-02', lines: [{ quantity: 1, unit_cost_minor: 1 }] } })).body.error.code).toBe('duplicate_invoice_number');
    const posted = await s.owner.call(invoicePost.POST, { params: { ...s.p, id: inv.body.data.id } , body: {} });
    expect(posted.body.data).toMatchObject({ status: 'posted', payment_status: 'unpaid', outstanding_minor: 126500 });
    const ij = await journal(s.biz.tenantId, 'supplier_invoice', inv.body.data.id);
    expect(balanced(ij)).toBe(true);
    const sum = (a: string) => ij.filter((r) => r.account === a).reduce((x, r) => x + r.debit_minor - r.credit_minor, 0);
    expect(sum('goods_received_not_invoiced')).toBe(100000);
    expect(sum('inventory')).toBe(10000); // price difference re-values stock still on hand
    expect(sum('input_tax')).toBe(16500);
    expect(sum('accounts_payable')).toBe(-126500);
    expect((await s.owner.call(itemOne.GET, { params: { ...s.p, id: dye } })).body.data.avg_cost_minor).toBe(110);
    expect(await onHand(s.biz.tenantId, dye)).toBe(1000);

    const pkey = `pay-${randomUUID()}`;
    const pbody = { supplier_id: sup.id, invoice_id: inv.body.data.id, amount_minor: 126500, method: 'bank', paid_on: '2026-11-05', reference: 'TT-1' };
    const p1 = await s.owner.call(payments.POST, { params: s.p, body: pbody, idempotencyKey: pkey });
    const p2 = await s.owner.call(payments.POST, { params: s.p, body: pbody, idempotencyKey: pkey });
    expect(p2.body.data.id).toBe(p1.body.data.id);
    expect((await s.owner.call(payments.GET, { params: s.p })).body.data).toHaveLength(1);
    const pj = await journal(s.biz.tenantId, 'supplier_payment', p1.body.data.id);
    expect(pj.map((r) => [r.account, r.debit_minor, r.credit_minor])).toEqual([['accounts_payable', 126500, 0], ['bank', 0, 126500]]);
    expect((await s.owner.call(payments.POST, { params: s.p, body: { ...pbody, amount_minor: 1 }, idempotencyKey: true })).body.error.code).toBe('overpayment');

    const val = (await s.owner.call(reports.GET, { params: { ...s.p, kind: 'valuation' } })).body.data;
    expect(val).toMatchObject({ inventory_value_minor: 110000, ledger_inventory_minor: 110000, difference_minor: 0, accounts_payable_minor: 0, received_not_invoiced_minor: 0, input_tax_minor: 16500 });
    const fr = await s.owner.call(financeReport.GET, { params: s.p, query: { from: '2026-11-01', to: '2026-11-30' } });
    expect(fr.body.data.inventory).toMatchObject({ value_minor: 110000, accounts_payable_minor: 0 });
  });

  it('product sale posts cost of goods at the frozen average; the finance report reads movement costs', async () => {
    const s = await shop();
    const prod = await createProduct(s.owner, s.biz.slug, {}, { cost_minor: 4000, initial_stock: 5 });
    const itemId = prod.variants[0]!.inventory_item_id;
    const open = await withTenant(s.biz.tenantId, (trx) => trx.selectFrom('stock_movements').select('id').where('inventory_item_id', '=', itemId).where('kind', '=', 'opening').executeTakeFirstOrThrow());
    expect((await journal(s.biz.tenantId, 'stock_movement', open.id)).map((r) => [r.account, r.debit_minor, r.credit_minor])).toEqual([['inventory', 20000, 0], ['owner_equity', 0, 20000]]);
    const buyer = await customer();
    await addToCart(buyer, s.biz.slug, prod.variants[0]!.id, 2);
    const o = await checkout(buyer, s.biz.slug);
    expect(o.status).toBe(201);
    await withTenant(s.biz.tenantId, (trx) => markOrderPaid(trx, s.biz.tenantId, o.body.data.id, { paymentId: randomUUID(), amountMinor: o.body.data.total_minor }));
    const sale = await withTenant(s.biz.tenantId, (trx) => trx.selectFrom('stock_movements').select(['id', 'total_cost_minor']).where('inventory_item_id', '=', itemId).where('kind', '=', 'sale').executeTakeFirstOrThrow());
    expect(sale.total_cost_minor).toBe(-8000);
    const j = await journal(s.biz.tenantId, 'stock_movement', sale.id);
    expect(j.map((r) => [r.account, r.debit_minor, r.credit_minor])).toEqual([['cogs', 8000, 0], ['inventory', 0, 8000]]);
    // Editing the product cost later changes neither the sale's cost nor the report.
    const today = new Date().toISOString().slice(0, 10);
    const before = (await s.owner.call(financeReport.GET, { params: s.p, query: { from: today, to: today } })).body.data.product_costs.amount_minor;
    expect(before).toBe(8000);
    await withTenant(s.biz.tenantId, (trx) => trx.updateTable('inventory_items').set({ cost_per_unit_minor: 9999 }).where('id', '=', itemId).execute());
    expect((await s.owner.call(financeReport.GET, { params: s.p, query: { from: today, to: today } })).body.data.product_costs.amount_minor).toBe(8000);
  });
});

describe('isolation, roles and plans', () => {
  it('another business cannot see or use locations, items or transfers by id', async () => {
    const a = await shop();
    const b = await shop();
    const dye = await material(a, { initial_quantity: 10 });
    const st = await station(a);
    const t = await a.owner.call(transfers.POST, { params: a.p, body: { from_location_id: a.main, to_location_id: st, lines: [{ inventory_item_id: dye, quantity: 1 }] }, idempotencyKey: true });
    expect((await b.owner.call(transferOne.GET, { params: { ...b.p, id: t.body.data.id } })).status).toBe(404);
    expect((await b.owner.call(locationOne.PATCH, { params: { ...b.p, id: st }, body: { name: 'x' } })).status).toBe(404);
    expect((await b.owner.call(itemMoves.GET, { params: { ...b.p, id: dye } })).status).toBe(404);
    const bDye = await material(b, { initial_quantity: 10 });
    const cross = await b.owner.call(transfers.POST, { params: b.p, body: { from_location_id: b.main, to_location_id: st, lines: [{ inventory_item_id: bDye, quantity: 1 }] }, idempotencyKey: true });
    expect(cross.status).toBe(404);
    const crossItem = await b.owner.call(transfers.POST, { params: b.p, body: { from_location_id: b.main, to_location_id: b.main, lines: [{ inventory_item_id: dye, quantity: 1 }] }, idempotencyKey: true });
    expect([404, 422]).toContain(crossItem.status);
    expect((await b.owner.call(locations.GET, { params: b.p })).body.data.map((l: any) => l.id)).not.toContain(st);
    // Not a member at all → the business does not exist for them.
    expect((await b.owner.call(locations.GET, { params: a.p })).status).toBe(404);
  });

  it('warehouse keeper moves stock but sees no costs or finance; finance sees supplier invoices', async () => {
    const s = await shop();
    const dye = await material(s, { initial_quantity: 10, cost_per_unit_minor: 5 });
    const st = await station(s);
    const wh = await addMember(s.owner, s.biz.slug, 'warehouse');
    const t = await wh.call(transfers.POST, { params: s.p, body: { from_location_id: s.main, to_location_id: st, lines: [{ inventory_item_id: dye, quantity: 1 }] }, idempotencyKey: true });
    expect(t.status).toBe(201);
    expect(t.body.data.lines[0]).not.toHaveProperty('unit_cost_minor');
    expect((await wh.call(financeReport.GET, { params: s.p, query: { from: '2026-11-01', to: '2026-11-30' } })).status).toBe(403);
    expect((await wh.call(invoices.GET, { params: s.p })).status).toBe(403);
    const fin = await addMember(s.owner, s.biz.slug, 'finance');
    expect((await fin.call(invoices.GET, { params: s.p })).status).toBe(200);
    expect((await fin.call(transfers.POST, { params: s.p, body: { from_location_id: s.main, to_location_id: st, lines: [{ inventory_item_id: dye, quantity: 1 }] }, idempotencyKey: true })).status).toBe(403);
  });

  it('downgrading keeps every inventory record; only creating more is blocked', async () => {
    const s = await shop('wahaj');
    const dye = await material(s, { initial_quantity: 10 });
    const st = await station(s);
    await s.owner.call(transfers.POST, { params: s.p, body: { from_location_id: s.main, to_location_id: st, lines: [{ inventory_item_id: dye, quantity: 4 }] }, idempotencyKey: true });
    const down = await s.owner.call(changePlan.POST, { params: s.p, body: { plan_code: 'sanaa', confirm_overage: true } });
    expect(down.status).toBe(200);
    expect((await s.owner.call(locations.POST, { params: s.p, body: { kind: 'station', name: 'جديد' } })).status).toBe(403);
    const kept = await withTenant(s.biz.tenantId, async (trx) => ({
      locations: (await trx.selectFrom('stock_locations').select('id').execute()).length,
      balances: (await trx.selectFrom('stock_balances').select(['location_id', 'on_hand']).where('inventory_item_id', '=', dye).execute()).map((b) => Number(b.on_hand)).sort(),
      transfers: (await trx.selectFrom('stock_transfers').select('id').execute()).length,
    }));
    expect(kept).toEqual({ locations: 2, balances: [4, 6], transfers: 1 });
    const up = await s.owner.call(changePlan.POST, { params: s.p, body: { plan_code: 'wahaj' } });
    expect(up.status).toBe(200);
    expect((await bal(s, dye))[st]!.on_hand).toBe(4);
  });
});

describe('manual issue idempotency (LUMA-AUDIT-011)', () => {
  const consumptionsOf = (tenantId: string, itemId: string) => withTenant(tenantId, (trx) => trx.selectFrom('stock_movements').select('id')
    .where('inventory_item_id', '=', itemId).where('kind', '=', 'consumption').execute());

  it('requires a key, replays the same operation once, refuses a reused key with another payload, and posts separate operations', async () => {
    const s = await shop();
    const dye = await material(s, { initial_quantity: 100, cost_per_unit_minor: 10 });
    const body = { inventory_item_id: dye, quantity: 3, reason: 'training session' };
    const noKey = await s.owner.call(issue.POST, { params: s.p, body });
    expect(noKey.status).toBe(422);
    expect(noKey.body.error.code).toBe('idempotency_key_required');

    const key = `issue-${randomUUID()}`;
    const first = await s.owner.call(issue.POST, { params: s.p, body, idempotencyKey: key });
    expect(first.status).toBe(201);
    const again = await s.owner.call(issue.POST, { params: s.p, body, idempotencyKey: key });
    expect(again.status).toBe(201);
    expect(again.body.data.id).toBe(first.body.data.id);
    expect(await onHand(s.biz.tenantId, dye)).toBe(97);

    const reused = await s.owner.call(issue.POST, { params: s.p, body: { ...body, quantity: 4 }, idempotencyKey: key });
    expect(reused.status).toBe(422);
    expect(reused.body.error.code).toBe('idempotency_key_reused');

    // A genuinely separate issue (same item, same quantity) carries its own key and posts.
    const second = await s.owner.call(issue.POST, { params: s.p, body, idempotencyKey: `issue-${randomUUID()}` });
    expect(second.status).toBe(201);
    expect(second.body.data.id).not.toBe(first.body.data.id);
    expect(await onHand(s.biz.tenantId, dye)).toBe(94);
    expect(await consumptionsOf(s.biz.tenantId, dye)).toHaveLength(2);

    // A refused issue (insufficient stock) leaves no key record: the same key can be retried after a fix.
    const k2 = `issue-${randomUUID()}`;
    expect((await s.owner.call(issue.POST, { params: s.p, body: { ...body, quantity: 500 }, idempotencyKey: k2 })).status).toBe(409);
    expect((await s.owner.call(issue.POST, { params: s.p, body: { ...body, quantity: 500 }, idempotencyKey: k2 })).status).toBe(409);
    expect(await findStockMismatches(s.biz.tenantId)).toEqual([]);
  });

  it('concurrent retries of one operation create exactly one consumption movement', async () => {
    const s = await shop();
    const dye = await material(s, { initial_quantity: 50, cost_per_unit_minor: 10 });
    const key = `issue-${randomUUID()}`;
    const body = { inventory_item_id: dye, quantity: 2, reason: 'parallel retry' };
    const results = await Promise.all(Array.from({ length: 6 }, () => s.owner.call(issue.POST, { params: s.p, body, idempotencyKey: key })));
    for (const r of results) expect([201, 409]).toContain(r.status);
    const ok = results.filter((r) => r.status === 201);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    expect(new Set(ok.map((r) => r.body.data.id)).size).toBe(1);
    // Any 409 is "request_in_progress", never a second posting.
    for (const r of results.filter((x) => x.status === 409)) expect(r.body.error.code).toBe('request_in_progress');
    expect(await consumptionsOf(s.biz.tenantId, dye)).toHaveLength(1);
    expect(await onHand(s.biz.tenantId, dye)).toBe(48);

    // Two genuinely separate concurrent issues both succeed.
    const sep = await Promise.all([1, 2].map(() => s.owner.call(issue.POST, { params: s.p, body, idempotencyKey: `issue-${randomUUID()}` })));
    expect(sep.map((r) => r.status), JSON.stringify(sep.map((r) => r.body))).toEqual([201, 201]);
    expect(await consumptionsOf(s.biz.tenantId, dye)).toHaveLength(3);
    expect(await onHand(s.biz.tenantId, dye)).toBe(44);
  });
});
