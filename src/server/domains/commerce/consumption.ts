import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { z } from 'zod';
import { withTenant, type Tx } from '../../db/client';
import { Errors } from '../../http/errors';
import { audit, type AuditActor } from '../../infra/audit';
import { notifyCapability } from '../../infra/notify';
import { hasCapability, type TenantAccess } from '../../tenancy/access';
import { moveStock, tenantSlug } from './stock';
import { counterpartItem, loadLocation, locationForBookingItem } from './locations';
import { convertUnits, milli, round3, type Unit } from '@/shared/units';
import type { actualUsageInput, issueInput, usagePlanInput } from '@/shared/schemas/inventory';

/**
 * Material consumption (requirement 6).
 *
 * One `material_consumptions` row per (booking item, material): expected
 * quantity from the approved recipe, actual quantity (defaults to expected;
 * may be planned before completion or corrected after with
 * inventory.adjust_usage), what was posted, what is short, and waste.
 * Expected and actual are NOT two consumptions: only the actual quantity is
 * posted, once, at completion (guarded by booking_items.materials_consumed_at
 * and the movement's exactly-once index). Waste is its own movement.
 *
 * Location: the station serving the chair allocated to the booking item, else
 * the default location of the booking's branch. Tools are never consumed.
 *
 * Shortage: consumption is posted up to what is available at that location
 * (never negative, never stock reserved for orders); the missing quantity is
 * kept on the row (shortage_qty) and an inventory task is opened, so nothing
 * is lost: the task can post the remainder once stock arrives, or write it off.
 *
 * Cancellation: materials are not reserved for bookings, so cancelling a
 * booking only cancels planned (pending) usage. Used material never returns
 * automatically on cancel or refund.
 */
export type ConsumptionResult = {
  consumed: Array<{ inventoryItemId: string; quantity: number; unit: string }>;
  skipped: 'no_recipe' | 'already_consumed' | null;
  shortages: Array<{ inventoryItemId: string; required: number; consumed: number; unit: string }>;
};

async function performerUser(trx: Tx, staffId: string | null) {
  if (!staffId) return null;
  const m = await trx.selectFrom('tenant_memberships').select('user_id').where('staff_profile_id', '=', staffId).where('status', '=', 'active').executeTakeFirst();
  return m?.user_id ?? null;
}

/** Takes up to `want` from the location (available = on hand − reserved). Returns the posted quantity and cost. */
async function take(trx: Tx, tenantId: string, itemId: string, locationId: string, want: number, mv: { refType: string; refId: string; actorUserId: string | null; performerStaffId: string | null; consumptionId: string }) {
  if (want <= 0) return { qty: 0, cost: 0, movementId: null as string | null };
  const bal = await trx.selectFrom('stock_balances').select(['on_hand', 'reserved']).where('tenant_id', '=', tenantId)
    .where('inventory_item_id', '=', itemId).where('location_id', '=', locationId).forUpdate().executeTakeFirst();
  const avail = Math.max(0, milli(Number(bal?.on_hand ?? 0)) - milli(Number(bal?.reserved ?? 0)));
  const q = Math.min(milli(want), avail) / 1000;
  if (q <= 0) return { qty: 0, cost: 0, movementId: null };
  const r = await moveStock(trx, tenantId, itemId, {
    kind: 'consumption', quantity: -q, dOnHand: -q, dReserved: 0, reason: 'service completed', refType: mv.refType, refId: mv.refId,
    actorUserId: mv.actorUserId, locationId, performerStaffId: mv.performerStaffId, documentType: 'material_consumption', documentId: mv.consumptionId,
  });
  if (!r) throw Errors.conflict('concurrent_update', 'Stock changed during consumption; retry');
  return { qty: q, cost: -(r.totalCostMinor ?? 0), movementId: r.movementId };
}

async function openShortageTask(trx: Tx, tenantId: string, c: { id: string; inventory_item_id: string; location_id: string; booking_item_id: string | null }, payload: Record<string, unknown>) {
  await sql`insert into inventory_tasks (tenant_id, kind, inventory_item_id, location_id, ref_type, ref_id, dedupe_key, payload)
    values (${tenantId}, 'shortage', ${c.inventory_item_id}, ${c.location_id}, 'material_consumption', ${c.id}, ${`shortage:${c.id}`}, ${JSON.stringify(payload)}::jsonb)
    on conflict (tenant_id, dedupe_key) where status = 'open' do update set payload = excluded.payload`.execute(trx);
}

/**
 * Posts a booking item's materials EXACTLY ONCE (see module doc). With no
 * recipe and no planned usage nothing is consumed and the item is NOT marked.
 */
export async function consumeMaterialsForBookingItem(trx: Tx, tenantId: string, bookingItemId: string, actorUserId: string | null): Promise<ConsumptionResult> {
  const bi = await trx.selectFrom('booking_items as bi').innerJoin('bookings as b', 'b.id', 'bi.booking_id')
    .select(['bi.id', 'bi.service_id', 'bi.materials_consumed_at', 'bi.booking_id', 'bi.staff_id', 'b.branch_id'])
    .where('bi.tenant_id', '=', tenantId).where('bi.id', '=', bookingItemId).forUpdate().executeTakeFirst();
  if (!bi) throw Errors.notFound('booking_item');
  if (bi.materials_consumed_at) return { consumed: [], skipped: 'already_consumed', shortages: [] };
  const where = await locationForBookingItem(trx, tenantId, bookingItemId);
  const recipe = await trx.selectFrom('service_material_recipes as r').innerJoin('inventory_items as ii', 'ii.id', 'r.inventory_item_id')
    .select(['r.inventory_item_id', 'r.quantity', 'r.unit', 'ii.unit as item_unit', 'ii.is_tool'])
    .where('r.tenant_id', '=', tenantId).where('r.service_id', '=', bi.service_id).orderBy('r.inventory_item_id').execute();
  const planned = await trx.selectFrom('material_consumptions').selectAll().where('booking_item_id', '=', bookingItemId).where('status', '=', 'pending').execute();
  if (!recipe.length && !planned.length) return { consumed: [], skipped: 'no_recipe', shortages: [] };

  // Lines: recipe materials (expected) + planned extras, mapped to the item card of the serving branch.
  type L = { itemId: string | null; sourceItemId: string; unit: string; expected: number; actual: number | null; row?: (typeof planned)[number] };
  const lines: L[] = [];
  for (const r of recipe) {
    if (r.is_tool) continue;
    const expected = convertUnits(Number(r.quantity), r.unit as Unit, r.item_unit as Unit);
    if (expected === null || expected <= 0) continue;
    const itemId = await counterpartItem(trx, tenantId, r.inventory_item_id, where.branchId);
    lines.push({ itemId, sourceItemId: r.inventory_item_id, unit: r.item_unit, expected, actual: null });
  }
  for (const p of planned) {
    const l = lines.find((x) => x.itemId === p.inventory_item_id || x.sourceItemId === p.inventory_item_id);
    if (l) { l.actual = p.actual_qty == null ? null : Number(p.actual_qty); l.row = p; } else lines.push({ itemId: p.inventory_item_id, sourceItemId: p.inventory_item_id, unit: p.unit, expected: Number(p.expected_qty), actual: p.actual_qty == null ? null : Number(p.actual_qty), row: p });
  }
  const performerUserId = await performerUser(trx, bi.staff_id);
  const consumed: ConsumptionResult['consumed'] = [];
  const shortages: ConsumptionResult['shortages'] = [];
  const now = new Date();
  for (const l of lines.sort((a, b) => (a.itemId ?? '').localeCompare(b.itemId ?? ''))) {
    const required = round3(l.actual ?? l.expected);
    const itemId = l.itemId ?? l.sourceItemId;
    let rowId = l.row?.id;
    if (!rowId) {
      const ins = await trx.insertInto('material_consumptions').values({
        tenant_id: tenantId, source: 'service', booking_id: bi.booking_id, booking_item_id: bookingItemId, service_id: bi.service_id,
        inventory_item_id: itemId, location_id: where.locationId, resource_id: where.resourceId, unit: l.unit, expected_qty: l.expected,
        actual_qty: required, performer_staff_id: bi.staff_id, performer_user_id: performerUserId, status: 'pending', created_by: actorUserId,
      }).returning('id').executeTakeFirstOrThrow();
      rowId = ins.id;
    }
    // No counterpart card in the serving branch: nothing can be taken there.
    const t = l.itemId
      ? await take(trx, tenantId, l.itemId, where.locationId, required, { refType: 'booking_item', refId: bookingItemId, actorUserId, performerStaffId: bi.staff_id, consumptionId: rowId })
      : { qty: 0, cost: 0, movementId: null };
    const short = round3(required - t.qty);
    await trx.updateTable('material_consumptions').set({
      location_id: where.locationId, resource_id: where.resourceId, actual_qty: required, posted_qty: t.qty, shortage_qty: short,
      total_cost_minor: t.cost, status: short > 0 ? 'shortage' : 'posted', posted_at: now, posted_by: actorUserId,
      performer_staff_id: bi.staff_id, performer_user_id: performerUserId,
      movement_ids: t.movementId ? sql`array_append(movement_ids, ${t.movementId}::uuid)` : sql`movement_ids`,
    }).where('id', '=', rowId).execute();
    if (t.qty > 0) consumed.push({ inventoryItemId: itemId, quantity: t.qty, unit: l.unit });
    if (short > 0) {
      shortages.push({ inventoryItemId: itemId, required, consumed: t.qty, unit: l.unit });
      await openShortageTask(trx, tenantId, { id: rowId, inventory_item_id: itemId, location_id: where.locationId, booking_item_id: bookingItemId },
        { booking_item_id: bookingItemId, required, consumed: t.qty, missing: short, unit: l.unit });
    }
  }
  await trx.updateTable('booking_items').set({ materials_consumed_at: now }).where('id', '=', bookingItemId).execute();
  if (shortages.length) {
    const slug = await tenantSlug(trx, tenantId);
    await notifyCapability(trx, tenantId, ['inventory.manage'], {
      kind: 'inventory.consumption_shortage',
      title_ar: 'نقص في مواد خدمة مكتملة', title_en: 'Material shortage on a completed service',
      body_ar: 'سُجّل الاستهلاك بقدر المتاح في موقع الخدمة، وفُتحت مهمة نقص بالكمية الباقية.',
      body_en: 'Consumption was recorded up to what the serving location had; a shortage task holds the rest.',
      target_path: slug ? `/app/${slug}/inventory?tab=tasks` : undefined,
      data: { booking_item_id: bookingItemId, shortages },
      dedupe_key: `consumption_shortage:${bookingItemId}`,
    });
    await audit(trx, { userId: actorUserId, kind: actorUserId ? 'user' : 'system' }, 'inventory.consumption_shortage', { tenantId, targetType: 'booking_item', targetId: bookingItemId, data: { shortages } });
  }
  return { consumed, skipped: null, shortages };
}

export async function consumeForBookingItem(access: TenantAccess, actor: AuditActor, bookingItemId: string) {
  return withTenant(access.tenantId, (trx) => consumeMaterialsForBookingItem(trx, access.tenantId, bookingItemId, actor.userId));
}

/** Booking cancelled / no-show before completion: planned usage is cancelled (nothing was reserved or taken). */
export async function cancelPlannedUsage(trx: Tx, tenantId: string, bookingId: string) {
  await trx.updateTable('material_consumptions').set({ status: 'cancelled' })
    .where('tenant_id', '=', tenantId).where('booking_id', '=', bookingId).where('status', '=', 'pending').execute();
}

/** Plans the actual usage of a booking item before it is completed (posted at completion). */
export async function planUsage(access: TenantAccess, actor: AuditActor, bookingItemId: string, input: z.infer<typeof usagePlanInput>) {
  return withTenant(access.tenantId, async (trx) => {
    const bi = await trx.selectFrom('booking_items').select(['id', 'booking_id', 'service_id', 'staff_id', 'materials_consumed_at']).where('id', '=', bookingItemId).forUpdate().executeTakeFirst();
    if (!bi) throw Errors.notFound('booking_item');
    if (!canAdjustUsage(access, bi.staff_id)) throw Errors.forbidden();
    if (bi.materials_consumed_at) throw Errors.conflict('already_consumed', 'Materials were already posted; correct the posted usage instead');
    const where = await locationForBookingItem(trx, access.tenantId, bookingItemId);
    const out = [];
    for (const l of input.lines) {
      const it = await trx.selectFrom('inventory_items').select(['id', 'unit', 'kind', 'is_tool']).where('id', '=', l.inventory_item_id).executeTakeFirst();
      if (!it) throw Errors.notFound('inventory_item');
      if (it.is_tool || it.kind === 'retail') throw Errors.invalid('not_a_material');
      const rec = await trx.selectFrom('service_material_recipes').select(['quantity', 'unit']).where('service_id', '=', bi.service_id).where('inventory_item_id', '=', it.id).executeTakeFirst();
      const expected = rec ? convertUnits(Number(rec.quantity), rec.unit as Unit, it.unit as Unit) ?? 0 : 0;
      const row = await trx.insertInto('material_consumptions').values({
        tenant_id: access.tenantId, source: 'service', booking_id: bi.booking_id, booking_item_id: bi.id, service_id: bi.service_id,
        inventory_item_id: it.id, location_id: where.locationId, resource_id: where.resourceId, unit: it.unit, expected_qty: expected,
        actual_qty: l.actual_qty, performer_staff_id: bi.staff_id, status: 'pending', created_by: actor.userId,
      }).onConflict((oc) => oc.columns(['tenant_id', 'booking_item_id', 'inventory_item_id']).where('booking_item_id', 'is not', null).doUpdateSet({ actual_qty: l.actual_qty, version: sql`material_consumptions.version + 1` }))
        .returningAll().executeTakeFirstOrThrow();
      out.push(row);
    }
    await audit(trx, actor, 'inventory.usage_planned', { tenantId: access.tenantId, targetType: 'booking_item', targetId: bookingItemId, data: { lines: input.lines } });
    return out;
  });
}

function canAdjustUsage(access: TenantAccess, _performerStaffId: string | null) {
  return hasCapability(access, ['inventory.adjust_usage', 'inventory.manage']);
}

/**
 * Corrects the actual usage of a posted consumption (inventory.adjust_usage):
 * more → an extra consumption movement (shortage if the location lacks it);
 * less → a return_from_use movement at the consumption's frozen average cost.
 * Idempotent on the target quantity (same value twice changes nothing).
 */
export async function correctUsage(access: TenantAccess, actor: AuditActor, id: string, input: z.infer<typeof actualUsageInput>) {
  return withTenant(access.tenantId, async (trx) => {
    const c = await trx.selectFrom('material_consumptions').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
    if (!c) throw Errors.notFound('material_consumption');
    if (!canAdjustUsage(access, c.performer_staff_id)) throw Errors.forbidden();
    if (c.version !== input.version) throw Errors.versionConflict(c.version);
    if (c.status === 'cancelled') throw Errors.conflict('consumption_cancelled');
    const target = round3(input.actual_qty);
    if (c.status === 'pending') {
      await trx.updateTable('material_consumptions').set({ actual_qty: target, version: c.version + 1, reason: input.reason }).where('id', '=', id).execute();
      return loadConsumption(trx, id);
    }
    const posted = Number(c.posted_qty);
    const opId = randomUUID();
    let postedNew = posted, cost = Number(c.total_cost_minor), movementId: string | null = null;
    if (milli(target) > milli(posted)) {
      const t = await take(trx, access.tenantId, c.inventory_item_id, c.location_id, round3(target - posted), { refType: 'usage_correction', refId: opId, actorUserId: actor.userId, performerStaffId: c.performer_staff_id, consumptionId: id });
      postedNew = round3(posted + t.qty); cost += t.cost; movementId = t.movementId;
    } else if (milli(target) < milli(posted)) {
      const back = round3(posted - target);
      const unit = posted > 0 ? cost / posted : null;
      const r = await moveStock(trx, access.tenantId, c.inventory_item_id, {
        kind: 'return_from_use', quantity: back, dOnHand: back, dReserved: 0, reason: input.reason, refType: 'usage_correction', refId: opId,
        actorUserId: actor.userId, locationId: c.location_id, unitCostMinor: unit, documentType: 'material_consumption', documentId: id, performerStaffId: c.performer_staff_id,
      });
      if (!r) throw Errors.conflict('concurrent_update');
      postedNew = target; cost -= r.totalCostMinor ?? 0; movementId = r.movementId;
    }
    const short = Math.max(0, round3(target - postedNew));
    await trx.updateTable('material_consumptions').set({
      actual_qty: target, posted_qty: postedNew, shortage_qty: short, total_cost_minor: Math.max(0, cost), status: short > 0 ? 'shortage' : 'posted',
      reason: input.reason, version: c.version + 1,
      movement_ids: movementId ? sql`array_append(movement_ids, ${movementId}::uuid)` : sql`movement_ids`,
    }).where('id', '=', id).execute();
    if (short > 0) await openShortageTask(trx, access.tenantId, c, { booking_item_id: c.booking_item_id, required: target, consumed: postedNew, missing: short, unit: c.unit });
    else await closeShortageTask(trx, access.tenantId, id, actor.userId, 'usage corrected');
    await audit(trx, actor, 'inventory.usage_corrected', { tenantId: access.tenantId, targetType: 'material_consumption', targetId: id, data: { from: Number(c.actual_qty ?? c.expected_qty), to: target, reason: input.reason } });
    return loadConsumption(trx, id);
  });
}

async function closeShortageTask(trx: Tx, tenantId: string, consumptionId: string, userId: string | null, resolution: string) {
  await trx.updateTable('inventory_tasks').set({ status: 'resolved', resolution, resolved_by: userId, resolved_at: new Date() })
    .where('tenant_id', '=', tenantId).where('dedupe_key', '=', `shortage:${consumptionId}`).where('status', '=', 'open').execute();
}

/** Waste during a service (a separate movement, never part of the consumption). */
export async function recordConsumptionWaste(access: TenantAccess, actor: AuditActor, id: string, quantity: number, reason: string) {
  return withTenant(access.tenantId, async (trx) => {
    const c = await trx.selectFrom('material_consumptions').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
    if (!c) throw Errors.notFound('material_consumption');
    if (!canAdjustUsage(access, c.performer_staff_id)) throw Errors.forbidden();
    const r = await moveStock(trx, access.tenantId, c.inventory_item_id, {
      kind: 'waste', quantity: -quantity, dOnHand: -quantity, dReserved: 0, reason, actorUserId: actor.userId, locationId: c.location_id,
      refType: 'usage_waste', refId: randomUUID(), documentType: 'material_consumption', documentId: id, performerStaffId: c.performer_staff_id,
    });
    if (!r) throw Errors.conflict('insufficient_stock', 'The location does not hold that quantity');
    await trx.updateTable('material_consumptions').set({ waste_qty: sql`waste_qty + ${quantity}::numeric`, movement_ids: sql`array_append(movement_ids, ${r.movementId}::uuid)` }).where('id', '=', id).execute();
    await audit(trx, actor, 'inventory.waste', { tenantId: access.tenantId, targetType: 'material_consumption', targetId: id, data: { quantity, reason } });
    return loadConsumption(trx, id);
  });
}

/** Manual issue with a documented reason (no booking): posted at once from the chosen location. */
export async function issueMaterial(access: TenantAccess, actor: AuditActor, input: z.infer<typeof issueInput>) {
  return withTenant(access.tenantId, async (trx) => {
    const it = await trx.selectFrom('inventory_items').select(['id', 'unit', 'kind', 'is_tool', 'branch_id']).where('id', '=', input.inventory_item_id).executeTakeFirst();
    if (!it) throw Errors.notFound('inventory_item');
    if (it.is_tool) throw Errors.invalid('tool_not_consumable', 'Tools are reused, not consumed');
    const loc = input.location_id ? await loadLocation(trx, input.location_id) : null;
    let qty = input.quantity;
    if (input.unit && input.unit !== it.unit) {
      const c = convertUnits(qty, input.unit, it.unit as Unit);
      if (c === null) throw Errors.invalid('incompatible_units');
      qty = c;
    }
    if (input.staff_id) {
      const st = await trx.selectFrom('staff_profiles').select('id').where('id', '=', input.staff_id).executeTakeFirst();
      if (!st) throw Errors.notFound('staff');
    }
    const locationId = loc?.id ?? (await trx.selectFrom('stock_locations').select('id').where('branch_id', '=', it.branch_id).where('is_default', '=', true).executeTakeFirstOrThrow()).id;
    const row = await trx.insertInto('material_consumptions').values({
      tenant_id: access.tenantId, source: 'manual', inventory_item_id: it.id, location_id: locationId, unit: it.unit, expected_qty: 0, actual_qty: qty,
      performer_staff_id: input.staff_id ?? null, performer_user_id: actor.userId, status: 'pending', reason: input.reason, created_by: actor.userId,
    }).returning('id').executeTakeFirstOrThrow();
    const r = await moveStock(trx, access.tenantId, it.id, {
      kind: 'consumption', quantity: -qty, dOnHand: -qty, dReserved: 0, reason: input.reason, refType: 'material_consumption', refId: row.id,
      actorUserId: actor.userId, locationId, performerStaffId: input.staff_id ?? null, documentType: 'material_consumption', documentId: row.id,
    });
    if (!r) throw Errors.conflict('insufficient_stock', 'The location does not hold that quantity');
    await trx.updateTable('material_consumptions').set({ posted_qty: qty, total_cost_minor: -(r.totalCostMinor ?? 0), status: 'posted', posted_at: new Date(), posted_by: actor.userId, movement_ids: [r.movementId] }).where('id', '=', row.id).execute();
    await audit(trx, actor, 'inventory.manual_issue', { tenantId: access.tenantId, targetType: 'material_consumption', targetId: row.id, data: { quantity: qty, reason: input.reason } });
    return loadConsumption(trx, row.id);
  });
}

/** Shortage task actions: post what is still missing (when stock arrived) or write it off. */
export async function resolveShortage(trx: Tx, access: TenantAccess, actor: AuditActor, consumptionId: string, action: 'post_remaining' | 'write_off', resolution?: string) {
  const c = await trx.selectFrom('material_consumptions').selectAll().where('id', '=', consumptionId).forUpdate().executeTakeFirst();
  if (!c) throw Errors.notFound('material_consumption');
  const missing = Number(c.shortage_qty);
  if (c.status !== 'shortage' || missing <= 0) { await closeShortageTask(trx, access.tenantId, consumptionId, actor.userId, 'nothing missing'); return { remaining: 0 }; }
  if (action === 'write_off') {
    await trx.updateTable('material_consumptions').set({ actual_qty: c.posted_qty, shortage_qty: 0, status: 'posted', reason: resolution ?? 'written off', version: c.version + 1 }).where('id', '=', consumptionId).execute();
    await closeShortageTask(trx, access.tenantId, consumptionId, actor.userId, resolution ?? 'written off');
    return { remaining: 0 };
  }
  const t = await take(trx, access.tenantId, c.inventory_item_id, c.location_id, missing, { refType: 'shortage_topup', refId: randomUUID(), actorUserId: actor.userId, performerStaffId: c.performer_staff_id, consumptionId });
  const left = round3(missing - t.qty);
  await trx.updateTable('material_consumptions').set({
    posted_qty: round3(Number(c.posted_qty) + t.qty), shortage_qty: left, total_cost_minor: Number(c.total_cost_minor) + t.cost,
    status: left > 0 ? 'shortage' : 'posted', version: c.version + 1,
    movement_ids: t.movementId ? sql`array_append(movement_ids, ${t.movementId}::uuid)` : sql`movement_ids`,
  }).where('id', '=', consumptionId).execute();
  if (left > 0) await openShortageTask(trx, access.tenantId, c, { booking_item_id: c.booking_item_id, required: Number(c.actual_qty), consumed: round3(Number(c.posted_qty) + t.qty), missing: left, unit: c.unit });
  else await closeShortageTask(trx, access.tenantId, consumptionId, actor.userId, resolution ?? 'remaining quantity posted');
  return { remaining: left };
}

async function loadConsumption(trx: Tx, id: string) {
  const c = await trx.selectFrom('material_consumptions').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
  const num = (v: unknown) => (v == null ? null : Number(v));
  return { ...c, expected_qty: Number(c.expected_qty), actual_qty: num(c.actual_qty), posted_qty: Number(c.posted_qty), shortage_qty: Number(c.shortage_qty), waste_qty: Number(c.waste_qty) };
}

export async function listConsumptions(access: TenantAccess, q: { booking_item_id?: string; status?: string; limit?: number }) {
  return withTenant(access.tenantId, async (trx) => {
    let s = trx.selectFrom('material_consumptions as c').innerJoin('inventory_items as i', 'i.id', 'c.inventory_item_id').innerJoin('stock_locations as l', 'l.id', 'c.location_id')
      .leftJoin('services as sv', 'sv.id', 'c.service_id').leftJoin('staff_profiles as sp', 'sp.id', 'c.performer_staff_id').leftJoin('resources as r', 'r.id', 'c.resource_id')
      .select(['c.id', 'c.source', 'c.booking_id', 'c.booking_item_id', 'c.inventory_item_id', 'i.name as item_name', 'c.unit', 'c.location_id', 'l.name as location_name',
        'sv.name_ar as service_name_ar', 'sv.name_en as service_name_en', 'sp.display_name as performer_name', 'r.name as chair_name',
        'c.expected_qty', 'c.actual_qty', 'c.posted_qty', 'c.shortage_qty', 'c.waste_qty', 'c.total_cost_minor', 'c.status', 'c.reason', 'c.version', 'c.posted_at', 'c.created_at']);
    if (q.booking_item_id) s = s.where('c.booking_item_id', '=', q.booking_item_id);
    if (q.status) s = s.where('c.status', '=', q.status);
    const rows = await s.orderBy('c.created_at', 'desc').limit(q.limit ?? 200).execute();
    const costs = hasCapability(access, 'costs.view');
    return rows.map(({ total_cost_minor, ...r }) => ({
      ...r, expected_qty: Number(r.expected_qty), actual_qty: r.actual_qty == null ? null : Number(r.actual_qty), posted_qty: Number(r.posted_qty),
      shortage_qty: Number(r.shortage_qty), waste_qty: Number(r.waste_qty), ...(costs ? { total_cost_minor } : {}),
    }));
  });
}
