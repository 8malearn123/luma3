import { sql } from 'kysely';
import type { z } from 'zod';
import { withTenant, type Tx } from '../../db/client';
import { Errors } from '../../http/errors';
import { audit, type AuditActor } from '../../infra/audit';
import { featureEnabled, hasCapability, type TenantAccess } from '../../tenancy/access';
import { adoptManualCost, moveStock, primaryBranchId, type StockKind } from './stock';
import { loadLocation } from './locations';
import { idleReasonSql } from './idle';
import { convertUnits, milli, round3, unitsCompatible, type Unit } from '@/shared/units';
import type { inventoryItemInput, inventoryItemPatch, inventoryListQuery, MovementInput, recipeInput } from '@/shared/schemas/commerce';

/**
 * Operational inventory: retail items (one per product variant and branch),
 * service-consumption materials, and "both". Materials are consumed by service
 * recipes exactly once per booking item; manual adjustments log a mandatory
 * reason (and may reference the visit whose actual usage differed).
 */
function encodeCursor(v: Record<string, unknown>) {
  return Buffer.from(JSON.stringify(v)).toString('base64url');
}
function decodeCursor<T>(c: string | undefined): T | null {
  if (!c) return null;
  try { return JSON.parse(Buffer.from(c, 'base64url').toString('utf8')) as T; } catch { throw Errors.invalid('invalid_cursor'); }
}

function stripCost<T extends Record<string, unknown>>(access: TenantAccess, row: T): T {
  if (hasCapability(access, 'costs.view')) return row;
  const { cost_per_unit_minor: _c, avg_cost_minor: _a, stock_value_minor: _v, freelancer_price_minor: _f, ...rest } = row;
  return rest as T;
}

function serializeItem(access: TenantAccess, r: Record<string, any>) {
  const onHand = Number(r.on_hand), reserved = Number(r.reserved);
  const available = round3(onHand - reserved);
  return stripCost(access, {
    ...r, on_hand: onHand, reserved, available,
    low_stock_threshold: r.low_stock_threshold == null ? null : Number(r.low_stock_threshold),
    low_stock: r.low_stock_threshold != null && available <= Number(r.low_stock_threshold),
    // `unit` is the usage (base) unit every quantity is stored in; `kind` is the usage kind.
    usage_unit: r.unit, usage_kind: r.kind,
    conversion_factor: r.conversion_factor == null ? null : Number(r.conversion_factor),
    avg_cost_minor: r.avg_cost_minor == null ? null : Number(r.avg_cost_minor),
  });
}

const itemSelect = [
  'ii.id', 'ii.branch_id', 'ii.variant_id', 'ii.name', 'ii.kind', 'ii.unit', 'ii.on_hand', 'ii.reserved', 'ii.low_stock_threshold',
  'ii.cost_per_unit_minor', 'ii.is_active', 'ii.updated_at', 'ii.created_at', 'v.product_id', 'v.sku',
  'ii.code', 'ii.barcode', 'ii.category', 'ii.description', 'ii.image_asset_id', 'ii.storage_unit', 'ii.conversion_factor',
  'ii.conversion_approved_at', 'ii.is_tool', 'ii.avg_cost_minor', 'ii.stock_value_minor', 'ii.freelancer_price_minor', 'ii.supplier_id',
  'ii.track_batches', 'ii.track_expiry', 'ii.archived_at', 'ii.master_id',
] as const;

export async function listItems(access: TenantAccess, query: z.infer<typeof inventoryListQuery>, opts: { branchIds?: string[] | null } = {}) {
  const branchIds = opts.branchIds ?? null;
  return withTenant(access.tenantId, async (trx) => {
    let q = trx.selectFrom('inventory_items as ii').leftJoin('product_variants as v', 'v.id', 'ii.variant_id').where('ii.tenant_id', '=', access.tenantId);
    if (branchIds) q = branchIds.length ? q.where('ii.branch_id', 'in', branchIds) : q.where(sql<boolean>`false`);
    if (query.kind && query.kind !== 'all') q = q.where('ii.kind', '=', query.kind);
    if (query.include_inactive !== '1') q = q.where('ii.is_active', '=', true);
    if (query.low === '1') q = q.where('ii.low_stock_threshold', 'is not', null).where(sql<boolean>`ii.on_hand - ii.reserved <= ii.low_stock_threshold`);
    if (query.idle === '1') q = q.where(sql<boolean>`(${idleReasonSql()}) is not null`);
    if (query.q) {
      const like = `%${query.q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
      q = q.where((eb) => eb.or([eb('ii.name', 'ilike', like), eb('v.sku', 'ilike', like), eb('v.barcode', 'ilike', like), eb('ii.code', 'ilike', like), eb('ii.barcode', 'ilike', like)]));
    }
    const dir = query.dir ?? (query.sort === 'updated' ? 'desc' : 'asc');
    const order = query.sort === 'available' ? sql`ii.on_hand - ii.reserved` : query.sort === 'on_hand' ? sql`ii.on_hand` : query.sort === 'updated' ? sql`ii.updated_at` : sql`ii.name`;
    const rows = await q.select([...itemSelect, idleReasonSql().as('idle_reason'), sql<number>`count(*) over ()`.as('total')]).orderBy(order, dir).orderBy('ii.id')
      .limit(query.limit).offset(query.offset).execute();
    let lowQ = trx.selectFrom('inventory_items').select(sql<number>`count(*)::int`.as('n')).where('is_active', '=', true);
    if (branchIds) lowQ = branchIds.length ? lowQ.where('branch_id', 'in', branchIds) : lowQ.where(sql<boolean>`false`);
    const lowCount = await lowQ
      .where('low_stock_threshold', 'is not', null).where(sql<boolean>`on_hand - reserved <= low_stock_threshold`).executeTakeFirstOrThrow();
    return { items: rows.map(({ total: _t, ...r }) => serializeItem(access, r)), total: Number(rows[0]?.total ?? 0), low_stock_count: lowCount.n };
  });
}

async function loadItem(trx: Tx, id: string) {
  const r = await trx.selectFrom('inventory_items as ii').leftJoin('product_variants as v', 'v.id', 'ii.variant_id').select([...itemSelect]).where('ii.id', '=', id).executeTakeFirst();
  if (!r) throw Errors.notFound('inventory_item');
  return r;
}

export async function getItem(access: TenantAccess, id: string) {
  return withTenant(access.tenantId, async (trx) => serializeItem(access, await loadItem(trx, id)));
}

export async function createMaterial(access: TenantAccess, actor: AuditActor, input: z.infer<typeof inventoryItemInput>) {
  if ((input.cost_per_unit_minor != null || input.freelancer_price_minor != null) && !hasCapability(access, 'costs.view')) throw Errors.forbidden('You cannot set confidential costs');
  return withTenant(access.tenantId, async (trx) => {
    const branchId = input.branch_id ?? await primaryBranchId(trx, access.tenantId);
    const { name, unit, initial_quantity, location_id, branch_id: _b, low_stock_threshold, cost_per_unit_minor, ...card } = input;
    await checkCardRefs(trx, card);
    const row = await trx.insertInto('inventory_items').values({
      tenant_id: access.tenantId, branch_id: branchId, name, kind: 'material', unit,
      low_stock_threshold: low_stock_threshold ?? null, cost_per_unit_minor: cost_per_unit_minor ?? null,
      ...card, track_expiry: card.track_expiry ?? false, track_batches: (card.track_batches ?? false) || (card.track_expiry ?? false),
      ...(card.conversion_factor != null ? { conversion_approved_by: actor.userId, conversion_approved_at: new Date() } : {}),
    }).returning('id').executeTakeFirstOrThrow();
    if (initial_quantity) {
      const r = await moveStock(trx, access.tenantId, row.id, { kind: 'opening', quantity: initial_quantity, dOnHand: initial_quantity, dReserved: 0, reason: 'opening stock', actorUserId: actor.userId, locationId: location_id ?? null, unitCostMinor: cost_per_unit_minor ?? null });
      if (!r) throw Errors.conflict('insufficient_stock');
    }
    await audit(trx, actor, 'inventory.item_created', { tenantId: access.tenantId, targetType: 'inventory_item', targetId: row.id, data: { name: input.name, unit: input.unit } });
    return serializeItem(access, await loadItem(trx, row.id));
  });
}

export async function updateItem(access: TenantAccess, actor: AuditActor, id: string, input: z.infer<typeof inventoryItemPatch>) {
  if ((input.cost_per_unit_minor !== undefined || input.freelancer_price_minor !== undefined) && !hasCapability(access, 'costs.view')) throw Errors.forbidden('You cannot set confidential costs');
  return withTenant(access.tenantId, async (trx) => {
    const cur = await loadItem(trx, id);
    if (input.kind && !cur.variant_id) throw Errors.invalid('invalid_kind', 'Only items linked to a product can be sold');
    const { archived, ...patch } = input;
    if (patch.is_tool && (patch.kind ?? cur.kind) !== 'material') throw Errors.invalid('tool_must_be_material', 'Only materials can be marked as tools');
    await checkCardRefs(trx, patch);
    const extra: Record<string, unknown> = {};
    if (patch.track_expiry) extra.track_batches = true;
    if (patch.conversion_factor !== undefined && patch.conversion_factor !== (cur.conversion_factor == null ? null : Number(cur.conversion_factor))) {
      // Saving a factor with inventory.manage is its approval (like recipes).
      Object.assign(extra, patch.conversion_factor == null ? { conversion_approved_by: null, conversion_approved_at: null } : { conversion_approved_by: actor.userId, conversion_approved_at: new Date() });
    }
    if (archived !== undefined) Object.assign(extra, archived ? { archived_at: new Date(), is_active: false } : { archived_at: null });
    if (archived && Number(cur.on_hand) > 0) throw Errors.conflict('item_has_stock', 'Count or move out the remaining stock before archiving');
    await trx.updateTable('inventory_items').set({ ...patch, ...extra }).where('id', '=', id).execute();
    if (patch.cost_per_unit_minor != null) await adoptManualCost(trx, access.tenantId, id, patch.cost_per_unit_minor, actor.userId);
    await audit(trx, actor, 'inventory.item_updated', { tenantId: access.tenantId, targetType: 'inventory_item', targetId: id, data: input });
    return serializeItem(access, await loadItem(trx, id));
  });
}

async function checkCardRefs(trx: Tx, card: { supplier_id?: string | null; image_asset_id?: string | null }) {
  if (card.supplier_id) {
    const sup = await trx.selectFrom('suppliers').select('id').where('id', '=', card.supplier_id).executeTakeFirst();
    if (!sup) throw Errors.notFound('supplier');
  }
  if (card.image_asset_id) {
    const a = await trx.selectFrom('assets').select('id').where('id', '=', card.image_asset_id).executeTakeFirst();
    if (!a) throw Errors.notFound('asset');
  }
}

/** Converts a quantity entered in `unit` to the item's base unit (or rejects incompatible units). */
export function toBaseUnit(quantity: number, unit: Unit | undefined, itemUnit: Unit): number {
  if (!unit || unit === itemUnit) return quantity;
  const c = convertUnits(quantity, unit, itemUnit);
  if (c === null) throw Errors.invalid('incompatible_units', `Cannot convert ${unit} to ${itemUnit}`, { from: unit, to: itemUnit });
  return c;
}

/**
 * Receipt, manual adjustment or waste. Retail stock can be managed from
 * Products (catalog.edit) on any plan with products; materials need the
 * inventory feature and inventory.manage. Quantities in another compatible
 * unit are converted (1 l received into an ml item = 1000 ml); incompatible
 * units are rejected. A receipt's cost is per entered unit and updates the
 * weighted average; waste needs a reason and posts shrinkage.
 */
export async function recordMovement(access: TenantAccess, actor: AuditActor, itemId: string, input: MovementInput) {
  return withTenant(access.tenantId, async (trx) => {
    const item = await loadItem(trx, itemId);
    if (item.kind === 'retail') {
      if (!hasCapability(access, ['inventory.manage', 'catalog.edit'])) throw Errors.forbidden();
      if (!featureEnabled(access, 'feature.products')) throw Errors.planFeature('feature.products');
    } else {
      if (!hasCapability(access, 'inventory.manage')) throw Errors.forbidden();
      if (!featureEnabled(access, 'feature.inventory')) throw Errors.planFeature('feature.inventory');
    }
    let qty = toBaseUnit(input.quantity, input.unit, item.unit as Unit);
    if (item.unit === 'piece' && !Number.isInteger(qty)) throw Errors.invalid('whole_units_required', 'Pieces must be whole numbers');
    if (qty === 0) throw Errors.invalid('quantity_too_small', 'The converted quantity rounds to zero');
    let ref: { refType: string; refId: string } | null = null;
    if (input.kind === 'adjustment' && input.booking_item_id) {
      const bi = await trx.selectFrom('booking_items').select('id').where('id', '=', input.booking_item_id).executeTakeFirst();
      if (!bi) throw Errors.notFound('booking_item');
      ref = { refType: 'booking_item', refId: bi.id };
    }
    if (input.location_id) await loadLocation(trx, input.location_id);
    let unitCost: number | null = null;
    if (input.kind === 'receipt' && input.unit_cost_minor != null) {
      if (!hasCapability(access, 'costs.view')) throw Errors.forbidden('You cannot set confidential costs');
      // Cost per entered unit → cost per base unit.
      unitCost = input.unit_cost_minor / toBaseUnit(1, input.unit, item.unit as Unit);
    }
    if (input.kind === 'waste') qty = -qty;
    if ((input.kind === 'receipt' && (input.batch_no || input.expiry_date)) && !item.track_batches) throw Errors.invalid('batches_not_tracked', 'This item does not track batches');
    if (input.kind === 'receipt' && item.track_expiry && !input.expiry_date) throw Errors.invalid('expiry_required', 'This item tracks expiry dates');
    const r = await moveStock(trx, access.tenantId, itemId, {
      kind: input.kind, quantity: qty, dOnHand: qty, dReserved: 0, reason: input.reason ?? null,
      refType: ref?.refType, refId: ref?.refId, actorUserId: actor.userId, locationId: input.location_id ?? null, unitCostMinor: unitCost,
      ...(input.kind === 'receipt' && input.batch_no ? { batch: { batchNo: input.batch_no, expiryDate: input.expiry_date ?? null } } : {}),
      ...(input.kind === 'waste' && input.batch_id ? { batches: [{ batchId: input.batch_id, quantity: -qty }] } : {}),
    });
    if (!r) throw Errors.conflict('insufficient_stock', 'This would take stock below zero or below what is reserved for orders');
    await audit(trx, actor, `inventory.${input.kind}`, { tenantId: access.tenantId, targetType: 'inventory_item', targetId: itemId, data: { quantity: qty, unit: item.unit, reason: input.reason ?? null, location_id: r.locationId, movement_id: r.movementId } });
    return serializeItem(access, await loadItem(trx, itemId));
  });
}

export async function listMovements(access: TenantAccess, itemId: string, opts: { limit: number; cursor?: string; location_id?: string }) {
  return withTenant(access.tenantId, async (trx) => {
    const item = await loadItem(trx, itemId);
    const feature = item.kind === 'retail' ? 'feature.products' : 'feature.inventory';
    if (!featureEnabled(access, feature)) throw Errors.planFeature(feature);
    const cur = decodeCursor<{ t: string; id: string }>(opts.cursor);
    let q = trx.selectFrom('stock_movements as m').leftJoin('users as u', 'u.id', 'm.actor_user_id').leftJoin('stock_locations as l', 'l.id', 'm.location_id')
      .leftJoin('stock_locations as cl', 'cl.id', 'm.counter_location_id').leftJoin('stock_batches as sb', 'sb.id', 'm.batch_id')
      .select(['m.id', 'm.kind', 'm.quantity', 'm.on_hand_after', 'm.reserved_after', 'm.reason', 'm.ref_type', 'm.ref_id', 'm.created_at', 'u.display_name as actor_name',
        'm.location_id', 'l.name as location_name', 'm.counter_location_id', 'cl.name as counter_location_name', 'm.location_on_hand_after', 'm.unit',
        'm.unit_cost_minor', 'm.total_cost_minor', 'm.document_type', 'm.document_id', 'm.reversal_of', 'sb.batch_no',
        sql<boolean>`exists (select 1 from stock_movements r where r.reversal_of = m.id)`.as('reversed')])
      .where('m.inventory_item_id', '=', itemId);
    if (opts.location_id) q = q.where('m.location_id', '=', opts.location_id);
    if (cur) q = q.where(sql<boolean>`(m.created_at, m.id) < (${new Date(cur.t)}, ${cur.id})`);
    const rows = await q.orderBy('m.created_at', 'desc').orderBy('m.id', 'desc').limit(opts.limit + 1).execute();
    const page = rows.slice(0, opts.limit);
    const last = page[page.length - 1];
    const costs = hasCapability(access, 'costs.view');
    return {
      items: page.map(({ unit_cost_minor, total_cost_minor, ...m }) => ({
        ...m, quantity: Number(m.quantity), on_hand_after: Number(m.on_hand_after), reserved_after: Number(m.reserved_after),
        location_on_hand_after: m.location_on_hand_after == null ? null : Number(m.location_on_hand_after),
        ...(costs ? { unit_cost_minor: unit_cost_minor == null ? null : Number(unit_cost_minor), total_cost_minor } : {}),
      })),
      next_cursor: rows.length > opts.limit && last ? encodeCursor({ t: new Date(last.created_at).toISOString(), id: last.id }) : null,
    };
  });
}

/** Kinds that a person may reverse with a correction movement (documents are voided through their own flow). */
const REVERSIBLE = new Set(['receipt', 'opening', 'adjustment', 'waste', 'return_from_use']);

/**
 * Completed movements are never edited. A mistake is corrected by a reversal
 * movement (kind 'correction', reversal_of = original) at the original's frozen
 * cost, which also reverses its journal entry. A movement is reversed at most once.
 */
export async function reverseMovement(access: TenantAccess, actor: AuditActor, movementId: string, reason: string) {
  return withTenant(access.tenantId, async (trx) => {
    const m = await trx.selectFrom('stock_movements').selectAll().where('id', '=', movementId).executeTakeFirst();
    if (!m) throw Errors.notFound('stock_movement');
    if (!REVERSIBLE.has(m.kind) || m.document_type) throw Errors.invalid('not_reversible', 'This movement belongs to a document; correct the document instead');
    const done = await trx.selectFrom('stock_movements').select('id').where('reversal_of', '=', movementId).executeTakeFirst();
    if (done) throw Errors.conflict('already_reversed');
    const q = -Number(m.quantity);
    const r = await moveStock(trx, access.tenantId, m.inventory_item_id, {
      kind: 'correction', quantity: q, dOnHand: q, dReserved: 0, reason, actorUserId: actor.userId, locationId: m.location_id,
      unitCostMinor: m.unit_cost_minor == null ? null : Number(m.unit_cost_minor), reversalOf: m.id, journalAs: m.kind as StockKind,
      refType: 'stock_movement', refId: m.id,
    });
    if (!r) throw Errors.conflict('insufficient_stock', 'The stock this would remove is no longer there');
    await audit(trx, actor, 'inventory.movement_reversed', { tenantId: access.tenantId, targetType: 'stock_movement', targetId: movementId, data: { reason, correction_id: r.movementId } });
    return { id: r.movementId, reversal_of: movementId, on_hand: r.onHand };
  });
}

// ── Recipes ─────────────────────────────────────────────────────────────────
export async function listRecipes(access: TenantAccess) {
  return withTenant(access.tenantId, async (trx) => {
    const services = await trx.selectFrom('services').select(['id', 'name_ar', 'name_en', 'is_active']).where('archived_at', 'is', null).orderBy('sort').orderBy('created_at').execute();
    const lines = await trx.selectFrom('service_material_recipes as r').innerJoin('inventory_items as ii', 'ii.id', 'r.inventory_item_id')
      .leftJoin('users as u', 'u.id', 'r.approved_by')
      .select(['r.service_id', 'r.inventory_item_id', 'r.quantity', 'r.unit', 'r.approved_at', 'u.display_name as approved_by_name', 'ii.name as item_name', 'ii.unit as item_unit', 'ii.is_active as item_active'])
      .execute();
    return services.map((s) => ({
      ...s,
      lines: lines.filter((l) => l.service_id === s.id).map((l) => ({ ...l, quantity: Number(l.quantity), item_quantity: convertUnits(Number(l.quantity), l.unit as Unit, l.item_unit as Unit) })),
    }));
  });
}

/** Replaces a service's recipe. Saving by someone with inventory.manage is the approval of the consumption rate. */
export async function setRecipe(access: TenantAccess, actor: AuditActor, serviceId: string, input: z.infer<typeof recipeInput>) {
  return withTenant(access.tenantId, async (trx) => {
    const svc = await trx.selectFrom('services').select('id').where('id', '=', serviceId).executeTakeFirst();
    if (!svc) throw Errors.notFound('service');
    const ids = [...new Set(input.lines.map((l) => l.inventory_item_id))];
    if (ids.length !== input.lines.length) throw Errors.invalid('duplicate_line', 'Each material can appear once per recipe');
    const items = ids.length ? await trx.selectFrom('inventory_items').select(['id', 'unit', 'kind', 'is_active', 'is_tool']).where('id', 'in', ids).execute() : [];
    if (items.length !== ids.length) throw Errors.notFound('inventory_item');
    for (const l of input.lines) {
      const it = items.find((i) => i.id === l.inventory_item_id)!;
      if (it.is_tool) throw Errors.invalid('tool_not_consumable', 'Tools are reused, not consumed by services');
      if (it.kind === 'retail') throw Errors.invalid('not_a_material', 'Only materials (or items marked "sold and consumed") can be used in recipes');
      if (!unitsCompatible(l.unit, it.unit as Unit)) throw Errors.invalid('incompatible_units', `Cannot convert ${l.unit} to ${it.unit}`, { from: l.unit, to: it.unit, inventory_item_id: it.id });
      if (it.unit === 'piece' && !Number.isInteger(l.quantity)) throw Errors.invalid('whole_units_required', 'Pieces must be whole numbers');
    }
    await trx.deleteFrom('service_material_recipes').where('service_id', '=', serviceId).execute();
    if (input.lines.length) {
      await trx.insertInto('service_material_recipes').values(input.lines.map((l) => ({
        tenant_id: access.tenantId, service_id: serviceId, inventory_item_id: l.inventory_item_id, quantity: l.quantity, unit: l.unit,
        approved_by: actor.userId, approved_at: new Date(),
      }))).execute();
    }
    await audit(trx, actor, 'inventory.recipe_set', { tenantId: access.tenantId, targetType: 'service', targetId: serviceId, data: { lines: input.lines } });
    return { service_id: serviceId, lines: input.lines.length };
  });
}

// ── Capacity estimate ───────────────────────────────────────────────────────
export type CapacityEstimate =
  | {
    status: 'ok'; serviceId: string; bookings: number; limitingItemId: string;
    method: string;
    lines: Array<{ inventoryItemId: string; name: string; unit: string; available: number; perBooking: number; bookings: number }>;
    disclosures: string[];
  }
  | { status: 'insufficient_data'; serviceId: string; reasons: string[]; method: string };

const METHOD = 'min over recipe lines of floor(available stock ÷ approved quantity per booking), in each item\'s unit; available = on hand − reserved for orders';

/**
 * "Enough for approximately N bookings". Without an approved recipe or reliable
 * stock data, no number is invented: status 'insufficient_data' with reasons.
 */
export async function capacityEstimate(trx: Tx, tenantId: string, serviceId: string): Promise<CapacityEstimate> {
  const lines = await trx.selectFrom('service_material_recipes as r').innerJoin('inventory_items as ii', 'ii.id', 'r.inventory_item_id')
    .select(['r.inventory_item_id', 'r.quantity', 'r.unit', 'r.approved_at', 'ii.name', 'ii.unit as item_unit', 'ii.on_hand', 'ii.reserved', 'ii.is_active',
      sql<boolean>`exists (select 1 from stock_movements m where m.inventory_item_id = ii.id and m.kind in ('receipt', 'adjustment', 'opening', 'count_adjustment', 'transfer_in', 'transfer_receive'))`.as('has_stock_records')])
    .where('r.tenant_id', '=', tenantId).where('r.service_id', '=', serviceId).orderBy('ii.name').execute();
  if (!lines.length) return { status: 'insufficient_data', serviceId, reasons: ['no_recipe'], method: METHOD };
  const reasons: string[] = [];
  for (const l of lines) {
    if (!l.approved_at) reasons.push(`recipe_not_approved:${l.inventory_item_id}`);
    if (!l.is_active) reasons.push(`material_inactive:${l.inventory_item_id}`);
    if (!l.has_stock_records) reasons.push(`no_stock_records:${l.inventory_item_id}`);
    if (convertUnits(Number(l.quantity), l.unit as Unit, l.item_unit as Unit) === null) reasons.push(`incompatible_units:${l.inventory_item_id}`);
  }
  if (reasons.length) return { status: 'insufficient_data', serviceId, reasons, method: METHOD };
  const out = lines.map((l) => {
    const per = convertUnits(Number(l.quantity), l.unit as Unit, l.item_unit as Unit)!;
    const available = Math.max(0, round3(Number(l.on_hand) - Number(l.reserved)));
    return { inventoryItemId: l.inventory_item_id, name: l.name, unit: l.item_unit, available, perBooking: per, bookings: Math.floor(milli(available) / milli(per)) };
  });
  const limiting = out.reduce((a, b) => (b.bookings < a.bookings ? b : a));
  return {
    status: 'ok', serviceId, bookings: limiting.bookings, limitingItemId: limiting.inventoryItemId, method: METHOD, lines: out,
    disclosures: ['estimate_assumes_recipe_usage', 'excludes_future_receipts', 'actual_usage_may_vary'],
  };
}

export async function capacityEstimates(access: TenantAccess) {
  return withTenant(access.tenantId, async (trx) => {
    const services = await trx.selectFrom('services').select(['id', 'name_ar', 'name_en']).where('archived_at', 'is', null).where('is_active', '=', true).orderBy('sort').execute();
    const out = [];
    for (const s of services) out.push({ ...s, estimate: await capacityEstimate(trx, access.tenantId, s.id) });
    return out;
  });
}

// ── Consumption on service completion: see consumption.ts ───────────────────
export { consumeMaterialsForBookingItem, consumeForBookingItem, type ConsumptionResult } from './consumption';
