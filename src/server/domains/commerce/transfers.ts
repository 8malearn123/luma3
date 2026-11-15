import { sql } from 'kysely';
import type { z } from 'zod';
import { withTenant, type Tx } from '../../db/client';
import { Errors } from '../../http/errors';
import { audit, type AuditActor } from '../../infra/audit';
import { nextReadableNumber } from '../../infra/counters';
import { idempotent, requestHash } from '../../infra/idempotency';
import { hasCapability, type TenantAccess } from '../../tenancy/access';
import { moveStock } from './stock';
import { counterpartItem, getSettings, loadLocation } from './locations';
import type { transferInput } from '@/shared/schemas/inventory';

/**
 * Transfers between locations (requirement 5, decision D4).
 *
 * A multi-item document, numbered TRF-…, executed atomically in one
 * transaction: every line moves or nothing does; no balance can go negative.
 *  - immediate (default setting): draft → completed. Per line a transfer_out
 *    at the source and a transfer_in at the destination.
 *  - confirm_receipt: draft → in_transit (transfer_dispatch at the source; the
 *    quantity is "in transit" at the destination and available in NEITHER
 *    location) → completed when the destination confirms (transfer_receive).
 *    Cancelling an in-transit transfer returns the goods to the source.
 * The moved quantity keeps its weighted-average cost (frozen on the line);
 * between branches it lands on the destination branch's card of the same item
 * (created on first transfer). Transfers post nothing to sales, consumption,
 * expenses or the journal. The document executes once (status guard under row
 * lock); the API route also takes an Idempotency-Key that replays the result.
 */
type TransferInput = z.infer<typeof transferInput>;

async function loadTransfer(trx: Tx, id: string, lock = false) {
  let q = trx.selectFrom('stock_transfers').selectAll().where('id', '=', id);
  if (lock) q = q.forUpdate();
  const t = await q.executeTakeFirst();
  if (!t) throw Errors.notFound('stock_transfer');
  return t;
}

export async function getTransferIn(trx: Tx, access: TenantAccess, id: string) {
  const t = await loadTransfer(trx, id);
  const lines = await trx.selectFrom('stock_transfer_lines as l').innerJoin('inventory_items as i', 'i.id', 'l.inventory_item_id')
    .select(['l.id', 'l.inventory_item_id', 'l.to_inventory_item_id', 'i.name', 'i.unit', 'l.quantity', 'l.unit_cost_minor', 'l.total_cost_minor', 'l.batches'])
    .where('l.transfer_id', '=', id).orderBy('i.name').execute();
  const costs = hasCapability(access, 'costs.view');
  const locs = await trx.selectFrom('stock_locations').select(['id', 'name']).where('id', 'in', [t.from_location_id, t.to_location_id]).execute();
  return {
    ...t, from_location_name: locs.find((l) => l.id === t.from_location_id)?.name ?? null, to_location_name: locs.find((l) => l.id === t.to_location_id)?.name ?? null,
    lines: lines.map(({ unit_cost_minor, total_cost_minor, ...l }) => ({ ...l, quantity: Number(l.quantity), ...(costs ? { unit_cost_minor: unit_cost_minor == null ? null : Number(unit_cost_minor), total_cost_minor } : {}) })),
  };
}

export async function getTransfer(access: TenantAccess, id: string) {
  return withTenant(access.tenantId, (trx) => getTransferIn(trx, access, id));
}

export async function listTransfers(access: TenantAccess, q: { status?: string } = {}) {
  return withTenant(access.tenantId, async (trx) => {
    let s = trx.selectFrom('stock_transfers as t').innerJoin('stock_locations as f', 'f.id', 't.from_location_id').innerJoin('stock_locations as d', 'd.id', 't.to_location_id')
      .select(['t.id', 't.number', 't.status', 't.mode', 't.note', 't.created_at', 't.dispatched_at', 't.received_at', 't.version', 'f.name as from_location_name', 'd.name as to_location_name',
        sql<number>`(select count(*)::int from stock_transfer_lines l where l.transfer_id = t.id)`.as('lines')]);
    if (q.status) s = s.where('t.status', '=', q.status);
    return s.orderBy('t.created_at', 'desc').limit(200).execute();
  });
}

async function createDraft(trx: Tx, access: TenantAccess, actor: AuditActor, input: TransferInput) {
  if (input.from_location_id === input.to_location_id) throw Errors.invalid('same_location', 'Choose two different locations');
  const from = await loadLocation(trx, input.from_location_id);
  const to = await loadLocation(trx, input.to_location_id);
  if (!from.is_active || !to.is_active) throw Errors.invalid('location_inactive');
  const ids = input.lines.map((l) => l.inventory_item_id);
  if (new Set(ids).size !== ids.length) throw Errors.invalid('duplicate_line', 'Each item can appear once');
  const items = await trx.selectFrom('inventory_items').select(['id', 'branch_id', 'unit']).where('id', 'in', ids).execute();
  if (items.length !== ids.length) throw Errors.notFound('inventory_item');
  for (const it of items) {
    if (it.branch_id !== from.branch_id) throw Errors.invalid('location_branch_mismatch', 'An item is not stocked in the source branch');
    const q = input.lines.find((l) => l.inventory_item_id === it.id)!.quantity;
    if (it.unit === 'piece' && !Number.isInteger(q)) throw Errors.invalid('whole_units_required', 'Pieces must be whole numbers');
  }
  const settings = await getSettings(trx, access.tenantId);
  const number = await nextReadableNumber(trx, access.tenantId, 'stock_transfer');
  const t = await trx.insertInto('stock_transfers').values({
    tenant_id: access.tenantId, number, from_location_id: from.id, to_location_id: to.id, mode: settings.transfer_confirmation,
    note: input.note || null, created_by: actor.userId,
  }).returning('id').executeTakeFirstOrThrow();
  const lines = [];
  for (const l of input.lines) {
    const toItem = await counterpartItem(trx, access.tenantId, l.inventory_item_id, to.branch_id, true);
    lines.push({ tenant_id: access.tenantId, transfer_id: t.id, inventory_item_id: l.inventory_item_id, to_inventory_item_id: toItem, quantity: l.quantity });
  }
  await trx.insertInto('stock_transfer_lines').values(lines).execute();
  await audit(trx, actor, 'inventory.transfer_created', { tenantId: access.tenantId, targetType: 'stock_transfer', targetId: t.id, data: { number, lines: input.lines.length } });
  return t.id;
}

/** Dispatch (or complete, in immediate mode) a draft. Executes exactly once. */
async function dispatchIn(trx: Tx, access: TenantAccess, actor: AuditActor, id: string) {
  const t = await loadTransfer(trx, id, true);
  if (t.status !== 'draft') throw Errors.conflict('transfer_not_draft', 'This transfer was already executed or cancelled');
  const lines = await trx.selectFrom('stock_transfer_lines').selectAll().where('transfer_id', '=', id).orderBy('inventory_item_id').execute();
  const immediate = t.mode === 'immediate';
  const short: Array<{ inventory_item_id: string; quantity: number }> = [];
  for (const l of lines) {
    const q = Number(l.quantity);
    const out = await moveStock(trx, access.tenantId, l.inventory_item_id, {
      kind: immediate ? 'transfer_out' : 'transfer_dispatch', quantity: -q, dOnHand: -q, dReserved: 0, reason: `${t.number}`,
      refType: 'stock_transfer_line', refId: l.id, actorUserId: actor.userId, locationId: t.from_location_id, counterLocationId: t.to_location_id,
      documentType: 'stock_transfer', documentId: id,
    });
    if (!out) { short.push({ inventory_item_id: l.inventory_item_id, quantity: q }); continue; }
    await trx.updateTable('stock_transfer_lines').set({ unit_cost_minor: out.unitCostMinor, total_cost_minor: out.totalCostMinor == null ? null : -out.totalCostMinor, batches: JSON.stringify(out.batches) }).where('id', '=', l.id).execute();
    if (immediate) {
      const inn = await moveStock(trx, access.tenantId, l.to_inventory_item_id ?? l.inventory_item_id, {
        kind: 'transfer_in', quantity: q, dOnHand: q, dReserved: 0, reason: `${t.number}`, refType: 'stock_transfer_line', refId: l.id,
        actorUserId: actor.userId, locationId: t.to_location_id, counterLocationId: t.from_location_id, unitCostMinor: out.unitCostMinor,
        batches: await mapBatches(trx, access.tenantId, out.batches, l.to_inventory_item_id ?? l.inventory_item_id), documentType: 'stock_transfer', documentId: id,
      });
      if (!inn) throw Errors.conflict('concurrent_update');
    } else {
      await trx.insertInto('stock_balances').values({ tenant_id: access.tenantId, inventory_item_id: l.to_inventory_item_id ?? l.inventory_item_id, location_id: t.to_location_id, in_transit: q })
        .onConflict((oc) => oc.columns(['tenant_id', 'inventory_item_id', 'location_id']).doUpdateSet({ in_transit: sql`stock_balances.in_transit + ${q}::numeric` })).execute();
    }
  }
  // Atomic: any line short → nothing moves (the transaction rolls back).
  if (short.length) throw Errors.conflict('insufficient_stock', 'The source location does not hold enough of some items', { lines: short });
  const now = new Date();
  await trx.updateTable('stock_transfers').set({
    status: immediate ? 'completed' : 'in_transit', dispatched_at: now, dispatched_by: actor.userId,
    ...(immediate ? { received_at: now, received_by: actor.userId } : {}), version: t.version + 1,
  }).where('id', '=', id).execute();
  await audit(trx, actor, immediate ? 'inventory.transfer_completed' : 'inventory.transfer_dispatched', { tenantId: access.tenantId, targetType: 'stock_transfer', targetId: id, data: { number: t.number } });
}

/** Batches keep their number and expiry across branches (the destination card gets its own batch rows). */
async function mapBatches(trx: Tx, tenantId: string, allocs: Array<{ batchId: string; quantity: number }>, toItemId: string) {
  const out = [];
  for (const a of allocs) {
    const b = await trx.selectFrom('stock_batches').select(['inventory_item_id', 'batch_no', 'expiry_date']).where('id', '=', a.batchId).executeTakeFirstOrThrow();
    if (b.inventory_item_id === toItemId) { out.push(a); continue; }
    await trx.insertInto('stock_batches').values({ tenant_id: tenantId, inventory_item_id: toItemId, batch_no: b.batch_no, expiry_date: b.expiry_date })
      .onConflict((oc) => oc.columns(['tenant_id', 'inventory_item_id', 'batch_no']).doNothing()).execute();
    const nb = await trx.selectFrom('stock_batches').select('id').where('inventory_item_id', '=', toItemId).where('batch_no', '=', b.batch_no).executeTakeFirstOrThrow();
    out.push({ batchId: nb.id, quantity: a.quantity });
  }
  return out;
}

/**
 * Creates a transfer and (by default) executes it, under the caller's
 * Idempotency-Key: the same key and body replay the first result, so a retried
 * request never moves stock twice.
 */
export async function createTransfer(access: TenantAccess, actor: AuditActor, input: TransferInput, idempotencyKey: string | null) {
  return withTenant(access.tenantId, async (trx) => {
    const run = async () => {
      const id = await createDraft(trx, access, actor, input);
      if (input.execute) await dispatchIn(trx, access, actor, id);
      return { status: 201, body: await getTransferIn(trx, access, id) };
    };
    if (!idempotencyKey) return (await run()).body;
    const r = await idempotent(trx, { scope: `tenant:${access.tenantId}`, operation: 'inventory.transfer', key: idempotencyKey, hash: requestHash(input) }, run);
    return r.body;
  });
}

export async function dispatchTransfer(access: TenantAccess, actor: AuditActor, id: string) {
  return withTenant(access.tenantId, async (trx) => {
    await dispatchIn(trx, access, actor, id);
    return getTransferIn(trx, access, id);
  });
}

/** Destination confirms receipt (confirm_receipt mode): in-transit becomes on hand. */
export async function receiveTransfer(access: TenantAccess, actor: AuditActor, id: string) {
  return withTenant(access.tenantId, async (trx) => {
    const t = await loadTransfer(trx, id, true);
    if (t.status !== 'in_transit') throw Errors.conflict('transfer_not_in_transit', 'Only a transfer in transit can be received');
    const lines = await trx.selectFrom('stock_transfer_lines').selectAll().where('transfer_id', '=', id).orderBy('inventory_item_id').execute();
    for (const l of lines) {
      const q = Number(l.quantity);
      const toItem = l.to_inventory_item_id ?? l.inventory_item_id;
      const r = await moveStock(trx, access.tenantId, toItem, {
        kind: 'transfer_receive', quantity: q, dOnHand: q, dReserved: 0, dInTransit: -q, reason: t.number, refType: 'stock_transfer_line', refId: l.id,
        actorUserId: actor.userId, locationId: t.to_location_id, counterLocationId: t.from_location_id,
        unitCostMinor: l.unit_cost_minor == null ? null : Number(l.unit_cost_minor),
        batches: await mapBatches(trx, access.tenantId, (l.batches as Array<{ batchId: string; quantity: number }>) ?? [], toItem), documentType: 'stock_transfer', documentId: id,
      });
      if (!r) throw Errors.conflict('concurrent_update');
    }
    await trx.updateTable('stock_transfers').set({ status: 'completed', received_at: new Date(), received_by: actor.userId, version: t.version + 1 }).where('id', '=', id).execute();
    await audit(trx, actor, 'inventory.transfer_received', { tenantId: access.tenantId, targetType: 'stock_transfer', targetId: id, data: { number: t.number } });
    return getTransferIn(trx, access, id);
  });
}

/** Draft: discarded. In transit: the goods go back to the source location. */
export async function cancelTransfer(access: TenantAccess, actor: AuditActor, id: string) {
  return withTenant(access.tenantId, async (trx) => {
    const t = await loadTransfer(trx, id, true);
    if (t.status !== 'draft' && t.status !== 'in_transit') throw Errors.conflict('transfer_closed', 'This transfer can no longer be cancelled');
    if (t.status === 'in_transit') {
      const lines = await trx.selectFrom('stock_transfer_lines').selectAll().where('transfer_id', '=', id).orderBy('inventory_item_id').execute();
      for (const l of lines) {
        const q = Number(l.quantity);
        const toItem = l.to_inventory_item_id ?? l.inventory_item_id;
        const res = await sql`update stock_balances set in_transit = in_transit - ${q}::numeric
          where tenant_id = ${access.tenantId} and inventory_item_id = ${toItem} and location_id = ${t.to_location_id} and in_transit >= ${q}::numeric`.execute(trx);
        if (!Number(res.numAffectedRows ?? 0)) throw Errors.conflict('concurrent_update');
        const r = await moveStock(trx, access.tenantId, l.inventory_item_id, {
          kind: 'transfer_receive', quantity: q, dOnHand: q, dReserved: 0, reason: `${t.number} cancelled`, refType: 'stock_transfer_return', refId: l.id,
          actorUserId: actor.userId, locationId: t.from_location_id, counterLocationId: t.to_location_id,
          unitCostMinor: l.unit_cost_minor == null ? null : Number(l.unit_cost_minor), batches: (l.batches as Array<{ batchId: string; quantity: number }>) ?? [],
          documentType: 'stock_transfer', documentId: id,
        });
        if (!r) throw Errors.conflict('concurrent_update');
      }
    }
    await trx.updateTable('stock_transfers').set({ status: 'cancelled', cancelled_at: new Date(), cancelled_by: actor.userId, version: t.version + 1 }).where('id', '=', id).execute();
    await audit(trx, actor, 'inventory.transfer_cancelled', { tenantId: access.tenantId, targetType: 'stock_transfer', targetId: id, data: { number: t.number, was: t.status } });
    return getTransferIn(trx, access, id);
  });
}

