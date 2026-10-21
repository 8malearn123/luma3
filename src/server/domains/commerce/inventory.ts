import { sql } from 'kysely';
import type { z } from 'zod';
import { withTenant, type Tx } from '../../db/client';
import { Errors } from '../../http/errors';
import { audit, type AuditActor } from '../../infra/audit';
import { notifyCapability } from '../../infra/notify';
import { featureEnabled, hasCapability, type TenantAccess } from '../../tenancy/access';
import { moveStock, primaryBranchId, tenantSlug } from './stock';
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
  const { cost_per_unit_minor: _c, ...rest } = row;
  return rest as T;
}

function serializeItem(access: TenantAccess, r: Record<string, any>) {
  const onHand = Number(r.on_hand), reserved = Number(r.reserved);
  const available = round3(onHand - reserved);
  return stripCost(access, {
    ...r, on_hand: onHand, reserved, available,
    low_stock_threshold: r.low_stock_threshold == null ? null : Number(r.low_stock_threshold),
    low_stock: r.low_stock_threshold != null && available <= Number(r.low_stock_threshold),
  });
}

const itemSelect = [
  'ii.id', 'ii.branch_id', 'ii.variant_id', 'ii.name', 'ii.kind', 'ii.unit', 'ii.on_hand', 'ii.reserved', 'ii.low_stock_threshold',
  'ii.cost_per_unit_minor', 'ii.is_active', 'ii.updated_at', 'ii.created_at', 'v.product_id', 'v.sku',
] as const;

export async function listItems(access: TenantAccess, query: z.infer<typeof inventoryListQuery>) {
  return withTenant(access.tenantId, async (trx) => {
    let q = trx.selectFrom('inventory_items as ii').leftJoin('product_variants as v', 'v.id', 'ii.variant_id').where('ii.tenant_id', '=', access.tenantId);
    if (query.kind && query.kind !== 'all') q = q.where('ii.kind', '=', query.kind);
    if (query.include_inactive !== '1') q = q.where('ii.is_active', '=', true);
    if (query.low === '1') q = q.where('ii.low_stock_threshold', 'is not', null).where(sql<boolean>`ii.on_hand - ii.reserved <= ii.low_stock_threshold`);
    if (query.q) {
      const like = `%${query.q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
      q = q.where((eb) => eb.or([eb('ii.name', 'ilike', like), eb('v.sku', 'ilike', like), eb('v.barcode', 'ilike', like)]));
    }
    const dir = query.dir ?? (query.sort === 'updated' ? 'desc' : 'asc');
    const order = query.sort === 'available' ? sql`ii.on_hand - ii.reserved` : query.sort === 'on_hand' ? sql`ii.on_hand` : query.sort === 'updated' ? sql`ii.updated_at` : sql`ii.name`;
    const rows = await q.select([...itemSelect, sql<number>`count(*) over ()`.as('total')]).orderBy(order, dir).orderBy('ii.id')
      .limit(query.limit).offset(query.offset).execute();
    const lowCount = await trx.selectFrom('inventory_items').select(sql<number>`count(*)::int`.as('n')).where('is_active', '=', true)
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
  if (input.cost_per_unit_minor != null && !hasCapability(access, 'costs.view')) throw Errors.forbidden('You cannot set confidential costs');
  return withTenant(access.tenantId, async (trx) => {
    const branchId = input.branch_id ?? await primaryBranchId(trx, access.tenantId);
    const row = await trx.insertInto('inventory_items').values({
      tenant_id: access.tenantId, branch_id: branchId, name: input.name, kind: 'material', unit: input.unit,
      low_stock_threshold: input.low_stock_threshold ?? null, cost_per_unit_minor: input.cost_per_unit_minor ?? null,
    }).returning('id').executeTakeFirstOrThrow();
    if (input.initial_quantity) {
      await moveStock(trx, access.tenantId, row.id, { kind: 'receipt', quantity: input.initial_quantity, dOnHand: input.initial_quantity, dReserved: 0, reason: 'opening stock', actorUserId: actor.userId });
    }
    await audit(trx, actor, 'inventory.item_created', { tenantId: access.tenantId, targetType: 'inventory_item', targetId: row.id, data: { name: input.name, unit: input.unit } });
    return serializeItem(access, await loadItem(trx, row.id));
  });
}

export async function updateItem(access: TenantAccess, actor: AuditActor, id: string, patch: z.infer<typeof inventoryItemPatch>) {
  if (patch.cost_per_unit_minor !== undefined && !hasCapability(access, 'costs.view')) throw Errors.forbidden('You cannot set confidential costs');
  return withTenant(access.tenantId, async (trx) => {
    const cur = await loadItem(trx, id);
    if (patch.kind && !cur.variant_id) throw Errors.invalid('invalid_kind', 'Only items linked to a product can be sold');
    await trx.updateTable('inventory_items').set(patch).where('id', '=', id).execute();
    await audit(trx, actor, 'inventory.item_updated', { tenantId: access.tenantId, targetType: 'inventory_item', targetId: id, data: patch });
    return serializeItem(access, await loadItem(trx, id));
  });
}

/**
 * Receipt or manual adjustment. Retail stock can be managed from Products
 * (catalog.edit) on any plan with products; materials need the inventory
 * feature and inventory.manage. Quantities in another compatible unit are
 * converted (1 l received into an ml item = 1000 ml); incompatible units are rejected.
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
    let qty = input.quantity;
    if (input.unit && input.unit !== item.unit) {
      const c = convertUnits(qty, input.unit, item.unit as Unit);
      if (c === null) throw Errors.invalid('incompatible_units', `Cannot convert ${input.unit} to ${item.unit}`, { from: input.unit, to: item.unit });
      qty = c;
    }
    if (item.unit === 'piece' && !Number.isInteger(qty)) throw Errors.invalid('whole_units_required', 'Pieces must be whole numbers');
    if (qty === 0) throw Errors.invalid('quantity_too_small', 'The converted quantity rounds to zero');
    let ref: { refType: string; refId: string } | null = null;
    if (input.kind === 'adjustment' && input.booking_item_id) {
      const bi = await trx.selectFrom('booking_items').select('id').where('id', '=', input.booking_item_id).executeTakeFirst();
      if (!bi) throw Errors.notFound('booking_item');
      ref = { refType: 'booking_item', refId: bi.id };
    }
    const r = await moveStock(trx, access.tenantId, itemId, {
      kind: input.kind, quantity: qty, dOnHand: qty, dReserved: 0, reason: input.reason ?? null,
      refType: ref?.refType, refId: ref?.refId, actorUserId: actor.userId,
    });
    if (!r) throw Errors.conflict('insufficient_stock', 'This would take stock below zero or below what is reserved for orders');
    await audit(trx, actor, `inventory.${input.kind}`, { tenantId: access.tenantId, targetType: 'inventory_item', targetId: itemId, data: { quantity: qty, unit: item.unit, reason: input.reason ?? null } });
    return serializeItem(access, await loadItem(trx, itemId));
  });
}

export async function listMovements(access: TenantAccess, itemId: string, opts: { limit: number; cursor?: string }) {
  return withTenant(access.tenantId, async (trx) => {
    const item = await loadItem(trx, itemId);
    const feature = item.kind === 'retail' ? 'feature.products' : 'feature.inventory';
    if (!featureEnabled(access, feature)) throw Errors.planFeature(feature);
    const cur = decodeCursor<{ t: string; id: string }>(opts.cursor);
    let q = trx.selectFrom('stock_movements as m').leftJoin('users as u', 'u.id', 'm.actor_user_id')
      .select(['m.id', 'm.kind', 'm.quantity', 'm.on_hand_after', 'm.reserved_after', 'm.reason', 'm.ref_type', 'm.ref_id', 'm.created_at', 'u.display_name as actor_name'])
      .where('m.inventory_item_id', '=', itemId);
    if (cur) q = q.where(sql<boolean>`(m.created_at, m.id) < (${new Date(cur.t)}, ${cur.id})`);
    const rows = await q.orderBy('m.created_at', 'desc').orderBy('m.id', 'desc').limit(opts.limit + 1).execute();
    const page = rows.slice(0, opts.limit);
    const last = page[page.length - 1];
    return {
      items: page.map((m) => ({ ...m, quantity: Number(m.quantity), on_hand_after: Number(m.on_hand_after), reserved_after: Number(m.reserved_after) })),
      next_cursor: rows.length > opts.limit && last ? encodeCursor({ t: new Date(last.created_at).toISOString(), id: last.id }) : null,
    };
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
    const items = ids.length ? await trx.selectFrom('inventory_items').select(['id', 'unit', 'kind', 'is_active']).where('id', 'in', ids).execute() : [];
    if (items.length !== ids.length) throw Errors.notFound('inventory_item');
    for (const l of input.lines) {
      const it = items.find((i) => i.id === l.inventory_item_id)!;
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
      sql<boolean>`exists (select 1 from stock_movements m where m.inventory_item_id = ii.id and m.kind in ('receipt', 'adjustment'))`.as('has_stock_records')])
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

// ── Consumption on service completion ───────────────────────────────────────
export type ConsumptionResult = {
  consumed: Array<{ inventoryItemId: string; quantity: number; unit: string }>;
  skipped: 'no_recipe' | 'already_consumed' | null;
  /** Lines where stock was insufficient: only what existed was recorded; managers are notified. */
  shortages: Array<{ inventoryItemId: string; required: number; consumed: number; unit: string }>;
};

/**
 * Deducts a service's recipe materials EXACTLY ONCE for a booking item.
 * Guards: the booking item row is locked and `materials_consumed_at` checked
 * and set in the same transaction; each movement is also unique per
 * (item, 'consumption', 'booking_item', id).
 *
 * Insufficient stock: never drives on_hand negative and never eats stock
 * reserved for customer orders — it records consumption up to what is
 * available, and reports the shortfall (return value + notification to
 * inventory.manage + audit) so the count can be corrected by an adjustment.
 * With no recipe nothing is consumed and the item is NOT marked consumed.
 */
export async function consumeMaterialsForBookingItem(trx: Tx, tenantId: string, bookingItemId: string, actorUserId: string | null): Promise<ConsumptionResult> {
  const bi = await trx.selectFrom('booking_items').select(['id', 'service_id', 'materials_consumed_at', 'booking_id'])
    .where('tenant_id', '=', tenantId).where('id', '=', bookingItemId).forUpdate().executeTakeFirst();
  if (!bi) throw Errors.notFound('booking_item');
  if (bi.materials_consumed_at) return { consumed: [], skipped: 'already_consumed', shortages: [] };
  const lines = await trx.selectFrom('service_material_recipes as r').innerJoin('inventory_items as ii', 'ii.id', 'r.inventory_item_id')
    .select(['r.inventory_item_id', 'r.quantity', 'r.unit', 'ii.unit as item_unit', 'ii.name'])
    .where('r.tenant_id', '=', tenantId).where('r.service_id', '=', bi.service_id).orderBy('r.inventory_item_id').execute();
  if (!lines.length) return { consumed: [], skipped: 'no_recipe', shortages: [] };

  const consumed: ConsumptionResult['consumed'] = [];
  const shortages: ConsumptionResult['shortages'] = [];
  for (const l of lines) {
    const required = convertUnits(Number(l.quantity), l.unit as Unit, l.item_unit as Unit);
    if (required === null || required <= 0) continue; // rejected at recipe save; defensive
    const take = await sql<{ take: number; on_hand: number; reserved: number }>`
      with cur as (
        select id, least(${required}::numeric, greatest(on_hand - reserved, 0)) as take
        from inventory_items where id = ${l.inventory_item_id} and tenant_id = ${tenantId} for update
      )
      select cur.take, i.on_hand, i.reserved from cur join inventory_items i on i.id = cur.id`.execute(trx);
    const t = Number(take.rows[0]?.take ?? 0);
    if (t > 0) {
      const r = await moveStock(trx, tenantId, l.inventory_item_id, {
        kind: 'consumption', quantity: -t, dOnHand: -t, dReserved: 0, reason: 'service completed',
        refType: 'booking_item', refId: bookingItemId, actorUserId,
      });
      if (!r) throw Errors.conflict('concurrent_update', 'Stock changed during consumption; retry');
      consumed.push({ inventoryItemId: l.inventory_item_id, quantity: t, unit: l.item_unit });
    }
    if (milli(t) < milli(required)) shortages.push({ inventoryItemId: l.inventory_item_id, required, consumed: t, unit: l.item_unit });
  }
  await trx.updateTable('booking_items').set({ materials_consumed_at: new Date() }).where('id', '=', bookingItemId).execute();
  if (shortages.length) {
    const slug = await tenantSlug(trx, tenantId);
    await notifyCapability(trx, tenantId, ['inventory.manage'], {
      kind: 'inventory.consumption_shortage',
      title_ar: 'نقص في مواد خدمة مكتملة', title_en: 'Material shortage on a completed service',
      body_ar: 'سُجّل الاستهلاك بقدر المتاح فقط. راجعي الجرد وسجّلي تسوية إذا لزم.',
      body_en: 'Consumption was recorded only up to available stock. Review the count and record an adjustment if needed.',
      target_path: slug ? `/app/${slug}/inventory` : undefined,
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
