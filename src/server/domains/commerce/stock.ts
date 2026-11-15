import { sql, type Tx } from '../../db/client';
import { Errors } from '../../http/errors';
import { notifyCapability } from '../../infra/notify';
import { emitDomainEvent } from '../../infra/domain-events';
import { postMovementJournal, postValuation } from './inventory-journal';
import { milli, round3 } from '@/shared/units';

/**
 * Stock ledger primitive. Three things change together in ONE transaction:
 *   - the append-only `stock_movements` row (with location, unit and frozen cost),
 *   - the per-location balance `stock_balances (item, location)`,
 *   - the branch total cache `inventory_items.on_hand/reserved` and the item's
 *     weighted-average value (`stock_value_minor`, `avg_cost_minor`).
 *
 * Guards: the item row and the balance row are locked (FOR UPDATE, item first)
 * and both are checked before anything is written: on_hand + Δ >= 0,
 * reserved + Δr >= 0, reserved + Δr <= on_hand + Δ, in_transit + Δt >= 0.
 * If a guard fails the function returns null WITHOUT writing; the DB CHECKs are
 * the backstop. Negative stock is never possible.
 *
 * Quantity sign convention (base unit of the item; quantity = Δon_hand except
 * reservation/release which only move `reserved`):
 *   receipt/opening/transfer_in/transfer_receive/return/return_from_use  +q
 *   sale −q (reserved −q too)   consumption/waste/transfer_out/transfer_dispatch/return_to_supplier −q
 *   reservation +q reserved      release +q (reserved −q)
 *   adjustment/count_adjustment/correction ±q
 *
 * Cost (D15, weighted average): value V and quantity Q of the item card.
 *   inbound  with unit cost c (else the current average): V += round(q·c); avg = V ÷ Q
 *            (first known cost for stock already on hand values it at c, posted as
 *            an opening valuation Dr inventory / Cr owner_equity)
 *   outbound cost = round(V · q ÷ Q) (all of V when Q reaches 0); avg unchanged
 *   Every movement stores unit_cost_minor/total_cost_minor; later cost edits never
 *   touch past movements. Unknown cost (no average yet) is stored as NULL.
 *
 * Location: default = the branch's default location (backward compatible with
 * all callers written before locations). Quarantine never serves a sale,
 * reservation or consumption.
 *
 * Exactly-once: movements tied to a business event are unique per
 * (item, kind, ref_type, ref_id) (manual adjustments excepted); callers' status
 * guards make that index a never-hit backstop.
 *
 * Journal: every costed movement posts its accounting effect once (ref
 * 'stock_movement', movement id) — see inventory-journal.ts. Transfers,
 * reservations and releases post nothing.
 *
 * Contract for other domains (e.g. workspace hosting selling a whole product to
 * a guest freelancer, D5):
 *   moveStock(trx, tenantId, itemId, { kind: 'sale', quantity: -q, dOnHand: -q, dReserved: 0,
 *     refType: 'workspace_booking_line', refId, actorUserId, locationId? })
 *   → { movementId, unitCostMinor, totalCostMinor (negative), … } | null (not enough stock)
 *   It posts Dr cogs / Cr inventory; the caller posts the revenue side.
 */
export type StockKind =
  | 'receipt' | 'reservation' | 'sale' | 'release' | 'return' | 'adjustment' | 'consumption'
  | 'opening' | 'transfer_out' | 'transfer_in' | 'transfer_dispatch' | 'transfer_receive'
  | 'return_from_use' | 'return_to_supplier' | 'waste' | 'count_adjustment' | 'correction';

export type BatchAlloc = { batchId: string; quantity: number };

export type MoveInput = {
  kind: StockKind;
  quantity: number;
  dOnHand: number;
  dReserved: number;
  reason?: string | null;
  refType?: string | null;
  refId?: string | null;
  actorUserId?: string | null;
  requireActive?: boolean;
  /** Default: the branch's default location. */
  locationId?: string | null;
  counterLocationId?: string | null;
  /** Δ of the location's in-transit quantity (confirm-receipt transfers). */
  dInTransit?: number;
  /** Inbound: cost per base unit (else the current average). Outbound: forces this cost (reversals). */
  unitCostMinor?: number | null;
  /** Explicit batch split (positive quantities). Outbound without it: FEFO. Inbound with `batch`: one batch. */
  batches?: BatchAlloc[];
  batch?: { batchNo: string; expiryDate?: string | null } | null;
  documentType?: string | null;
  documentId?: string | null;
  reversalOf?: string | null;
  performerStaffId?: string | null;
  /** Account mapping override (corrections post as the reverse of the original kind). */
  journalAs?: StockKind;
  /** Counter account for return_to_supplier (default goods_received_not_invoiced). */
  journalCounter?: 'accounts_payable' | 'goods_received_not_invoiced';
  /** false: the caller posts the accounting effect itself. */
  journal?: boolean;
};

export type MoveResult = {
  movementId: string;
  onHand: number; reserved: number; available: number;
  locationId: string; locationOnHand: number; locationAvailable: number;
  unitCostMinor: number | null; totalCostMinor: number | null;
  batches: BatchAlloc[];
};

const NO_SALE_FROM_QUARANTINE = new Set<StockKind>(['sale', 'reservation', 'consumption']);

/** The branch's default location (created if a branch somehow has none). */
export async function defaultLocationId(trx: Tx, tenantId: string, branchId: string): Promise<string> {
  const r = await sql<{ id: string }>`
    select app.ensure_default_stock_location(${tenantId}::uuid, b.id, b.name) as id from branches b where b.id = ${branchId} and b.tenant_id = ${tenantId}`.execute(trx);
  const id = r.rows[0]?.id;
  if (!id) throw Errors.notFound('branch');
  return id;
}

const n = (v: unknown) => (v == null ? null : Number(v));

export async function moveStock(trx: Tx, tenantId: string, itemId: string, m: MoveInput): Promise<MoveResult | null> {
  const item = await trx.selectFrom('inventory_items')
    .select(['id', 'branch_id', 'name', 'unit', 'on_hand', 'reserved', 'low_stock_threshold', 'is_active', 'avg_cost_minor', 'stock_value_minor', 'track_batches'])
    .where('id', '=', itemId).where('tenant_id', '=', tenantId).forUpdate().executeTakeFirst();
  if (!item) return null;
  if (m.requireActive && !item.is_active) return null;

  const locationId = m.locationId ?? await defaultLocationId(trx, tenantId, item.branch_id);
  const loc = await trx.selectFrom('stock_locations').select(['id', 'branch_id', 'kind', 'is_active'])
    .where('id', '=', locationId).where('tenant_id', '=', tenantId).executeTakeFirst();
  if (!loc) throw Errors.notFound('stock_location');
  if (loc.branch_id !== item.branch_id) throw Errors.invalid('location_branch_mismatch', 'This location is in another branch than the item');
  if (loc.kind === 'quarantine' && NO_SALE_FROM_QUARANTINE.has(m.kind)) throw Errors.invalid('quarantine_location', 'Quarantined stock cannot be sold, reserved or used');
  if (!loc.is_active && m.dOnHand > 0 && m.kind !== 'correction') throw Errors.invalid('location_inactive', 'This location is inactive');

  await trx.insertInto('stock_balances').values({ tenant_id: tenantId, inventory_item_id: itemId, location_id: locationId })
    .onConflict((oc) => oc.columns(['tenant_id', 'inventory_item_id', 'location_id']).doNothing()).execute();
  if (!m.locationId || loc.id === await defaultLocationId(trx, tenantId, item.branch_id)) {
    // Stock written to the branch cache without a location (before locations existed,
    // or by a raw import) belongs to the branch's default location.
    await sql`update stock_balances b set on_hand = b.on_hand + x.on_hand, reserved = b.reserved + x.reserved
      from (select ${item.on_hand}::numeric - coalesce(sum(on_hand), 0) as on_hand, ${item.reserved}::numeric - coalesce(sum(reserved), 0) as reserved
            from stock_balances where tenant_id = ${tenantId} and inventory_item_id = ${itemId}) x
      where b.tenant_id = ${tenantId} and b.inventory_item_id = ${itemId} and b.location_id = ${locationId}
        and x.on_hand >= 0 and x.reserved >= 0 and (x.on_hand > 0 or x.reserved > 0) and x.reserved <= b.on_hand + x.on_hand - b.reserved`.execute(trx);
  }
  const bal = await trx.selectFrom('stock_balances').select(['on_hand', 'reserved', 'in_transit', 'reorder_level'])
    .where('tenant_id', '=', tenantId).where('inventory_item_id', '=', itemId).where('location_id', '=', locationId).forUpdate().executeTakeFirstOrThrow();

  const d = milli(m.dOnHand), dr = milli(m.dReserved), dt = milli(m.dInTransit ?? 0);
  const iOn = milli(Number(item.on_hand)), iRes = milli(Number(item.reserved));
  const bOn = milli(Number(bal.on_hand)), bRes = milli(Number(bal.reserved)), bTr = milli(Number(bal.in_transit));
  const ok = (on: number, res: number) => on + d >= 0 && res + dr >= 0 && res + dr <= on + d;
  if (!ok(iOn, iRes) || !ok(bOn, bRes) || bTr + dt < 0) return null;

  // ── Cost (weighted average over the item card) ──
  const Q = iOn / 1000, q = Math.abs(d) / 1000;
  let V = Number(item.stock_value_minor);
  const A = n(item.avg_cost_minor);
  let newA = A;
  let unitCost: number | null = null;
  let total: number | null = null;
  let valuation = 0;
  if (d > 0) {
    const c = m.unitCostMinor ?? A;
    if (c != null) {
      if (A == null && iOn > 0) { valuation = Math.round(Q * c); V += valuation; }
      total = Math.round(q * c);
      unitCost = round4(c);
      V += total;
      newA = round4(V / ((iOn + d) / 1000));
    }
  } else if (d < 0) {
    if (A != null) {
      const after = iOn + d;
      if (after === 0) total = V;
      else if (m.unitCostMinor != null) total = Math.min(V, Math.round(q * m.unitCostMinor));
      else total = Math.round((V * Math.abs(d)) / iOn);
      V -= total;
      unitCost = round4(total / q);
      total = -total;
      if (after > 0) newA = round4(V / (after / 1000));
    }
  }

  const upd = await sql<{ on_hand: number; reserved: number }>`
    update inventory_items set on_hand = on_hand + ${m.dOnHand}::numeric, reserved = reserved + ${m.dReserved}::numeric,
      stock_value_minor = ${V}, avg_cost_minor = ${newA}
    where id = ${itemId} and tenant_id = ${tenantId} returning on_hand, reserved`.execute(trx);
  const row = upd.rows[0]!;
  const b = await sql<{ on_hand: number; reserved: number }>`
    update stock_balances set on_hand = on_hand + ${m.dOnHand}::numeric, reserved = reserved + ${m.dReserved}::numeric,
      in_transit = in_transit + ${m.dInTransit ?? 0}::numeric
    where tenant_id = ${tenantId} and inventory_item_id = ${itemId} and location_id = ${locationId} returning on_hand, reserved`.execute(trx);
  const brow = b.rows[0]!;

  // ── Batches ──
  let allocs: BatchAlloc[] = [];
  if (item.track_batches && d !== 0) allocs = await moveBatches(trx, tenantId, itemId, locationId, d, m);

  const mv = await trx.insertInto('stock_movements').values({
    tenant_id: tenantId, inventory_item_id: itemId, kind: m.kind, quantity: m.quantity,
    on_hand_after: row.on_hand, reserved_after: row.reserved, reason: m.reason ?? null,
    ref_type: m.refType ?? null, ref_id: m.refId ?? null, actor_user_id: m.actorUserId ?? null,
    location_id: locationId, counter_location_id: m.counterLocationId ?? null, location_on_hand_after: brow.on_hand,
    unit: item.unit, unit_cost_minor: unitCost, total_cost_minor: total,
    batch_id: allocs.length === 1 ? allocs[0]!.batchId : null,
    document_type: m.documentType ?? null, document_id: m.documentId ?? null,
    reversal_of: m.reversalOf ?? null, performer_staff_id: m.performerStaffId ?? null,
  }).returning('id').executeTakeFirstOrThrow();
  if (allocs.length) {
    await trx.insertInto('stock_movement_batches').values(allocs.map((a) => ({
      tenant_id: tenantId, movement_id: mv.id, batch_id: a.batchId, quantity: d > 0 ? a.quantity : -a.quantity,
    }))).execute();
  }

  if (m.journal !== false) {
    if (valuation > 0) await postValuation(trx, tenantId, mv.id, valuation, m.actorUserId ?? null, item.name);
    if (total) await postMovementJournal(trx, tenantId, { id: mv.id, kind: m.journalAs ?? m.kind, total, reversalOf: m.reversalOf ?? null, counter: m.journalCounter, memo: item.name, actorUserId: m.actorUserId ?? null });
  }

  const available = Number(row.on_hand) - Number(row.reserved);
  const locationAvailable = round3(Number(brow.on_hand) - Number(brow.reserved));
  await syncReorderTask(trx, tenantId, itemId, locationId, locationAvailable, n(bal.reorder_level), item.name);
  await syncLowStockAlert(trx, tenantId, itemId, item.name, available, n(item.low_stock_threshold));
  await emitDomainEvent(trx, tenantId, { type: 'stock.moved', item_id: itemId, available, threshold: n(item.low_stock_threshold) });
  return {
    movementId: mv.id, onHand: Number(row.on_hand), reserved: Number(row.reserved), available,
    locationId, locationOnHand: Number(brow.on_hand), locationAvailable,
    unitCostMinor: unitCost, totalCostMinor: total, batches: allocs,
  };
}

function round4(x: number) {
  return Math.round(x * 10000) / 10000;
}

/**
 * Batch quantities per location. Inbound: the given split, or one batch from
 * `batch` (created on first use), or unbatched. Outbound: the given split, or
 * FEFO (earliest expiry first, undated last); whatever the batches do not cover
 * comes from unbatched stock (stock received before tracking was switched on).
 */
async function moveBatches(trx: Tx, tenantId: string, itemId: string, locationId: string, d: number, m: MoveInput): Promise<BatchAlloc[]> {
  let allocs: BatchAlloc[] = m.batches?.filter((a) => a.quantity > 0) ?? [];
  if (d > 0) {
    if (!allocs.length && m.batch) {
      await trx.insertInto('stock_batches').values({ tenant_id: tenantId, inventory_item_id: itemId, batch_no: m.batch.batchNo, expiry_date: m.batch.expiryDate ?? null })
        .onConflict((oc) => oc.columns(['tenant_id', 'inventory_item_id', 'batch_no']).doNothing()).execute();
      const bt = await trx.selectFrom('stock_batches').select('id').where('tenant_id', '=', tenantId).where('inventory_item_id', '=', itemId).where('batch_no', '=', m.batch.batchNo).executeTakeFirstOrThrow();
      allocs = [{ batchId: bt.id, quantity: d / 1000 }];
    }
    for (const a of allocs) {
      await sql`insert into stock_batch_balances (tenant_id, batch_id, location_id, quantity) values (${tenantId}, ${a.batchId}, ${locationId}, ${a.quantity}::numeric)
        on conflict (tenant_id, batch_id, location_id) do update set quantity = stock_batch_balances.quantity + excluded.quantity`.execute(trx);
    }
    return allocs;
  }
  const rows = await trx.selectFrom('stock_batch_balances as bb').innerJoin('stock_batches as sb', 'sb.id', 'bb.batch_id')
    .select(['bb.batch_id', 'bb.quantity', 'sb.expiry_date'])
    .where('bb.tenant_id', '=', tenantId).where('bb.location_id', '=', locationId).where('sb.inventory_item_id', '=', itemId).where('bb.quantity', '>', 0)
    .orderBy(sql`sb.expiry_date asc nulls last`).orderBy('sb.created_at').forUpdate().execute();
  if (!allocs.length) {
    let need = -d;
    for (const r of rows) {
      if (need <= 0) break;
      const take = Math.min(need, milli(Number(r.quantity)));
      allocs.push({ batchId: r.batch_id, quantity: take / 1000 });
      need -= take;
    }
  }
  for (const a of allocs) {
    const res = await sql`update stock_batch_balances set quantity = quantity - ${a.quantity}::numeric
      where tenant_id = ${tenantId} and batch_id = ${a.batchId} and location_id = ${locationId} and quantity >= ${a.quantity}::numeric`.execute(trx);
    if (!Number(res.numAffectedRows ?? 0)) throw Errors.conflict('batch_insufficient', 'This batch does not hold that quantity here');
  }
  return allocs;
}

/** Per-location reorder level: one open reorder task while available ≤ level; resolved when restocked. */
async function syncReorderTask(trx: Tx, tenantId: string, itemId: string, locationId: string, available: number, level: number | null, name: string) {
  const key = `reorder:${itemId}:${locationId}`;
  if (level != null && milli(available) <= milli(level)) {
    await sql`insert into inventory_tasks (tenant_id, kind, inventory_item_id, location_id, dedupe_key, payload)
      values (${tenantId}, 'reorder', ${itemId}, ${locationId}, ${key}, ${JSON.stringify({ name, available, reorder_level: level })}::jsonb)
      on conflict (tenant_id, dedupe_key) where status = 'open' do nothing`.execute(trx);
    return;
  }
  await trx.updateTable('inventory_tasks').set({ status: 'resolved', resolution: 'restocked', resolved_at: new Date() })
    .where('tenant_id', '=', tenantId).where('dedupe_key', '=', key).where('status', '=', 'open').execute();
}

/**
 * Low-stock alert state machine, run on every movement. When available stock
 * is at or below the item's minimum and no alert is outstanding, the owner and
 * members with inventory.manage are notified once and `low_stock_alerted_at`
 * is set (atomically, so concurrent movements alert once). Further movements
 * while still low do not alert again. Once stock rises above the minimum
 * (restocked) the marker is cleared and the next crossing alerts again.
 */
export async function syncLowStockAlert(trx: Tx, tenantId: string, itemId: string, name: string, available: number, threshold: number | null) {
  if (threshold != null && available <= threshold) {
    const claimed = await trx.updateTable('inventory_items').set({ low_stock_alerted_at: new Date() })
      .where('id', '=', itemId).where('tenant_id', '=', tenantId).where('low_stock_alerted_at', 'is', null)
      .returning('low_stock_alerted_at').executeTakeFirst();
    if (claimed?.low_stock_alerted_at) await lowStockAlert(trx, tenantId, itemId, name, available, threshold, claimed.low_stock_alerted_at);
    return;
  }
  await trx.updateTable('inventory_items').set({ low_stock_alerted_at: null })
    .where('id', '=', itemId).where('tenant_id', '=', tenantId).where('low_stock_alerted_at', 'is not', null).execute();
}

async function lowStockAlert(trx: Tx, tenantId: string, itemId: string, name: string, available: number, threshold: number, alertedAt: Date) {
  const slug = await tenantSlug(trx, tenantId);
  await notifyCapability(trx, tenantId, ['business.manage', 'inventory.manage'], {
    kind: 'inventory.low_stock',
    title_ar: `مخزون منخفض: ${name}`,
    title_en: `Low stock: ${name}`,
    body_ar: `المتاح الآن ${available} (الحد الأدنى ${threshold}). لن يتكرر التنبيه حتى تُعاد تعبئة المخزون.`,
    body_en: `Available now: ${available} (minimum ${threshold}). No repeat alert until restocked.`,
    target_path: slug ? `/app/${slug}/inventory?item=${itemId}` : undefined,
    data: { inventory_item_id: itemId, available, threshold },
    dedupe_key: `low_stock:${itemId}:${alertedAt.getTime()}`,
  });
}

export async function tenantSlug(trx: Tx, tenantId: string): Promise<string | null> {
  const t = await trx.selectFrom('tenants').select('slug').where('id', '=', tenantId).executeTakeFirst();
  return t ? String(t.slug) : null;
}

/** Storefront orders and new retail items use the business's primary branch. */
export async function primaryBranchId(trx: Tx, tenantId: string): Promise<string> {
  const b = await trx.selectFrom('branches').select('id').where('tenant_id', '=', tenantId).where('status', '=', 'active')
    .orderBy('is_primary', 'desc').orderBy('created_at').executeTakeFirst();
  if (!b) throw Errors.invalid('no_branch', 'The business has no active branch');
  return b.id;
}

/**
 * A manual cost entered for an item whose weighted average is still unknown
 * becomes its first average (stock already on hand is valued at it, posted as
 * an opening valuation). Once an average exists, editing the manual cost
 * changes neither the average nor any past movement (D15).
 */
export async function adoptManualCost(trx: Tx, tenantId: string, itemId: string, cost: number | null | undefined, actorUserId: string | null) {
  if (cost == null) return;
  const it = await trx.selectFrom('inventory_items').select(['avg_cost_minor', 'on_hand', 'name']).where('id', '=', itemId).where('tenant_id', '=', tenantId).forUpdate().executeTakeFirst();
  if (!it || it.avg_cost_minor != null) return;
  const value = Math.round(Number(it.on_hand) * cost);
  await trx.updateTable('inventory_items').set({ avg_cost_minor: cost, stock_value_minor: value }).where('id', '=', itemId).execute();
  if (value > 0) await postValuation(trx, tenantId, itemId, value, actorUserId, it.name);
}
