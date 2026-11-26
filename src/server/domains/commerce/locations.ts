import { sql } from 'kysely';
import type { z } from 'zod';
import { withTenant, type Tx } from '../../db/client';
import { Errors } from '../../http/errors';
import { audit, type AuditActor } from '../../infra/audit';
import { hasCapability, requireWithinLimit, type TenantAccess } from '../../tenancy/access';
import { defaultLocationId, primaryBranchId } from './stock';
import { round3 } from '@/shared/units';
import type { balancesQuery, inventorySettingsInput, locationInput, locationPatch } from '@/shared/schemas/inventory';

/**
 * Stock locations (requirement 2). A location belongs to a branch; each branch
 * has one default location (main warehouse for the first branch, branch store
 * for the others) created by the database for every branch. Stations serve
 * chairs (resources) through stock_location_resources: the chair is the
 * bookable thing, the station holds the stock. Stock is owned by the location;
 * movements record who acted. Row-level security keeps every query inside the
 * caller's business, so another business's ids resolve to 404.
 */
export async function loadLocation(trx: Tx, id: string) {
  const l = await trx.selectFrom('stock_locations').selectAll().where('id', '=', id).executeTakeFirst();
  if (!l) throw Errors.notFound('stock_location');
  return l;
}

export async function getSettings(trx: Tx, tenantId: string) {
  const s = await trx.selectFrom('inventory_settings').selectAll().where('tenant_id', '=', tenantId).executeTakeFirst();
  return { transfer_confirmation: (s?.transfer_confirmation ?? 'immediate') as 'immediate' | 'confirm_receipt', expiry_warning_days: s?.expiry_warning_days ?? 30 };
}

export async function readSettings(access: TenantAccess) {
  return withTenant(access.tenantId, (trx) => getSettings(trx, access.tenantId));
}

export async function updateSettings(access: TenantAccess, actor: AuditActor, input: z.infer<typeof inventorySettingsInput>) {
  return withTenant(access.tenantId, async (trx) => {
    await trx.insertInto('inventory_settings').values({ tenant_id: access.tenantId, ...input, updated_by: actor.userId })
      .onConflict((oc) => oc.column('tenant_id').doUpdateSet({ ...input, updated_by: actor.userId })).execute();
    await audit(trx, actor, 'inventory.settings_updated', { tenantId: access.tenantId, targetType: 'inventory_settings', targetId: access.tenantId, data: input });
    return getSettings(trx, access.tenantId);
  });
}

export async function listLocations(access: TenantAccess, opts: { includeInactive?: boolean } = {}) {
  return withTenant(access.tenantId, async (trx) => {
    let q = trx.selectFrom('stock_locations as l').innerJoin('branches as b', 'b.id', 'l.branch_id').leftJoin('staff_profiles as sp', 'sp.id', 'l.staff_id')
      .select(['l.id', 'l.branch_id', 'b.name as branch_name', 'l.kind', 'l.name', 'l.code', 'l.staff_id', 'sp.display_name as staff_name', 'l.is_default', 'l.is_active', 'l.sort', 'l.created_at',
        sql<string[]>`coalesce((select array_agg(r.resource_id) from stock_location_resources r where r.location_id = l.id), '{}')`.as('resource_ids'),
        sql<number>`(select count(*)::int from stock_balances sb where sb.location_id = l.id and sb.on_hand > 0)`.as('items_in_stock'),
        sql<number>`coalesce((select sum(sb.on_hand * coalesce(i.avg_cost_minor, 0)) from stock_balances sb join inventory_items i on i.id = sb.inventory_item_id where sb.location_id = l.id), 0)::float8`.as('value_minor'),
      ]);
    if (!opts.includeInactive) q = q.where('l.is_active', '=', true);
    const rows = await q.orderBy('b.created_at').orderBy('l.is_default', 'desc').orderBy('l.sort').orderBy('l.name').execute();
    const costs = hasCapability(access, 'costs.view');
    return rows.map((r) => ({ ...r, value_minor: costs ? Math.round(Number(r.value_minor)) : undefined }));
  });
}

async function setResources(trx: Tx, tenantId: string, locationId: string, branchId: string, resourceIds: string[]) {
  const ids = [...new Set(resourceIds)];
  if (ids.length) {
    const res = await trx.selectFrom('resources').select(['id', 'branch_id']).where('id', 'in', ids).execute();
    if (res.length !== ids.length) throw Errors.notFound('resource');
    if (res.some((r) => r.branch_id !== branchId)) throw Errors.invalid('resource_other_branch', 'A chair can only be served by a station in its own branch');
  }
  await trx.deleteFrom('stock_location_resources').where('location_id', '=', locationId).execute();
  if (ids.length) {
    // A chair served elsewhere moves to this station.
    await trx.deleteFrom('stock_location_resources').where('resource_id', 'in', ids).execute();
    await trx.insertInto('stock_location_resources').values(ids.map((resource_id) => ({ tenant_id: tenantId, resource_id, location_id: locationId }))).execute();
  }
}

async function checkStaff(trx: Tx, staffId: string | null | undefined) {
  if (!staffId) return;
  const s = await trx.selectFrom('staff_profiles').select('id').where('id', '=', staffId).executeTakeFirst();
  if (!s) throw Errors.notFound('staff');
}

export async function createLocation(access: TenantAccess, actor: AuditActor, input: z.infer<typeof locationInput>) {
  return withTenant(access.tenantId, async (trx) => {
    const n = await trx.selectFrom('stock_locations').select(sql<number>`count(*)::int`.as('n')).where('is_active', '=', true).where('is_default', '=', false).executeTakeFirstOrThrow();
    requireWithinLimit(access, 'limit.stock_locations', n.n);
    const branchId = input.branch_id ?? await primaryBranchId(trx, access.tenantId);
    const br = await trx.selectFrom('branches').select('id').where('id', '=', branchId).executeTakeFirst();
    if (!br) throw Errors.notFound('branch');
    await defaultLocationId(trx, access.tenantId, branchId);
    if (input.kind === 'custody' && !input.staff_id) throw Errors.invalid('staff_required', 'A custody location needs the staff member who holds it');
    if (input.resource_ids?.length && input.kind !== 'station') throw Errors.invalid('station_only', 'Only a station serves chairs');
    await checkStaff(trx, input.staff_id);
    const row = await trx.insertInto('stock_locations').values({
      tenant_id: access.tenantId, branch_id: branchId, kind: input.kind, name: input.name, code: input.code ?? null,
      staff_id: input.staff_id ?? null, sort: input.sort ?? 0, created_by: actor.userId,
    }).returningAll().executeTakeFirstOrThrow();
    if (input.resource_ids) await setResources(trx, access.tenantId, row.id, branchId, input.resource_ids);
    await audit(trx, actor, 'inventory.location_created', { tenantId: access.tenantId, targetType: 'stock_location', targetId: row.id, data: { kind: input.kind, name: input.name } });
    return row;
  });
}

export async function updateLocation(access: TenantAccess, actor: AuditActor, id: string, patch: z.infer<typeof locationPatch>) {
  return withTenant(access.tenantId, async (trx) => {
    const cur = await loadLocation(trx, id);
    const { resource_ids, ...fields } = patch;
    if (cur.is_default && fields.is_active === false) throw Errors.invalid('default_location', 'The branch default location cannot be deactivated');
    if (fields.is_active === false) {
      const held = await trx.selectFrom('stock_balances').select('inventory_item_id').where('location_id', '=', id)
        .where((eb) => eb.or([eb('on_hand', '>', 0), eb('in_transit', '>', 0)])).executeTakeFirst();
      if (held) throw Errors.conflict('location_not_empty', 'Move or count out the stock in this location first');
    }
    if (fields.is_active === true && !cur.is_active && !cur.is_default) {
      const n = await trx.selectFrom('stock_locations').select(sql<number>`count(*)::int`.as('n')).where('is_active', '=', true).where('is_default', '=', false).executeTakeFirstOrThrow();
      requireWithinLimit(access, 'limit.stock_locations', n.n);
    }
    if (cur.kind === 'custody' && fields.staff_id === null) throw Errors.invalid('staff_required');
    await checkStaff(trx, fields.staff_id);
    if (resource_ids && cur.kind !== 'station') throw Errors.invalid('station_only', 'Only a station serves chairs');
    if (Object.keys(fields).length) await trx.updateTable('stock_locations').set(fields).where('id', '=', id).execute();
    if (resource_ids) await setResources(trx, access.tenantId, id, cur.branch_id, resource_ids);
    await audit(trx, actor, 'inventory.location_updated', { tenantId: access.tenantId, targetType: 'stock_location', targetId: id, data: patch });
    return loadLocation(trx, id);
  });
}

/** Balance by item × location, valued at the item's weighted average (costs.view only). */
export async function listBalances(access: TenantAccess, query: z.infer<typeof balancesQuery>) {
  return withTenant(access.tenantId, async (trx) => {
    let q = trx.selectFrom('stock_balances as b').innerJoin('inventory_items as i', 'i.id', 'b.inventory_item_id').innerJoin('stock_locations as l', 'l.id', 'b.location_id')
      .select(['b.inventory_item_id', 'i.name', 'i.unit', 'i.kind', 'i.is_tool', 'i.code', 'b.location_id', 'l.name as location_name', 'l.kind as location_kind', 'l.branch_id',
        'b.on_hand', 'b.reserved', 'b.in_transit', 'b.reorder_level', 'i.avg_cost_minor', sql<number>`count(*) over ()`.as('total')]);
    if (query.location_id) q = q.where('b.location_id', '=', query.location_id);
    if (query.branch_id) q = q.where('l.branch_id', '=', query.branch_id);
    if (query.inventory_item_id) q = q.where('b.inventory_item_id', '=', query.inventory_item_id);
    if (query.nonzero === '1') q = q.where((eb) => eb.or([eb('b.on_hand', '>', 0), eb('b.in_transit', '>', 0)]));
    const rows = await q.orderBy('i.name').orderBy('l.name').limit(query.limit).offset(query.offset).execute();
    const costs = hasCapability(access, 'costs.view');
    const items = rows.map(({ total: _t, avg_cost_minor, ...r }) => {
      const onHand = Number(r.on_hand), reserved = Number(r.reserved);
      const available = r.location_kind === 'quarantine' ? 0 : round3(onHand - reserved);
      return {
        ...r, on_hand: onHand, reserved, in_transit: Number(r.in_transit), available,
        reorder_level: r.reorder_level == null ? null : Number(r.reorder_level),
        below_reorder: r.reorder_level != null && available <= Number(r.reorder_level),
        ...(costs ? { avg_cost_minor: avg_cost_minor == null ? null : Number(avg_cost_minor), value_minor: avg_cost_minor == null ? null : Math.round(onHand * Number(avg_cost_minor)) } : {}),
      };
    });
    return { items, total: Number(rows[0]?.total ?? 0) };
  });
}

export async function setReorderLevel(access: TenantAccess, actor: AuditActor, itemId: string, locationId: string, level: number | null) {
  return withTenant(access.tenantId, async (trx) => {
    const it = await trx.selectFrom('inventory_items').select(['id', 'branch_id']).where('id', '=', itemId).executeTakeFirst();
    if (!it) throw Errors.notFound('inventory_item');
    const loc = await loadLocation(trx, locationId);
    if (loc.branch_id !== it.branch_id) throw Errors.invalid('location_branch_mismatch');
    await trx.insertInto('stock_balances').values({ tenant_id: access.tenantId, inventory_item_id: itemId, location_id: locationId, reorder_level: level })
      .onConflict((oc) => oc.columns(['tenant_id', 'inventory_item_id', 'location_id']).doUpdateSet({ reorder_level: level })).execute();
    await audit(trx, actor, 'inventory.reorder_level_set', { tenantId: access.tenantId, targetType: 'inventory_item', targetId: itemId, data: { location_id: locationId, reorder_level: level } });
    return { inventory_item_id: itemId, location_id: locationId, reorder_level: level };
  });
}

/**
 * The location that serves a booking item: the station linked to the chair
 * (resource) allocated to it, else the default location of the booking's branch.
 */
export async function locationForBookingItem(trx: Tx, tenantId: string, bookingItemId: string): Promise<{ locationId: string; branchId: string; resourceId: string | null }> {
  const bi = await trx.selectFrom('booking_items as bi').innerJoin('bookings as b', 'b.id', 'bi.booking_id')
    .select(['b.branch_id']).where('bi.id', '=', bookingItemId).executeTakeFirstOrThrow();
  const st = await trx.selectFrom('booking_allocations as a').innerJoin('stock_location_resources as r', 'r.resource_id', 'a.resource_id')
    .innerJoin('stock_locations as l', 'l.id', 'r.location_id')
    .select(['l.id', 'l.branch_id', 'a.resource_id']).where('a.tenant_id', '=', tenantId).where('a.booking_item_id', '=', bookingItemId)
    .where('a.resource_id', 'is not', null).where('l.is_active', '=', true).orderBy('a.created_at').executeTakeFirst();
  if (st) return { locationId: st.id, branchId: st.branch_id, resourceId: st.resource_id };
  const anyRes = await trx.selectFrom('booking_allocations').select('resource_id').where('tenant_id', '=', tenantId).where('booking_item_id', '=', bookingItemId)
    .where('resource_id', 'is not', null).executeTakeFirst();
  return { locationId: await defaultLocationId(trx, tenantId, bi.branch_id), branchId: bi.branch_id, resourceId: anyRes?.resource_id ?? null };
}

/**
 * The item card of `itemId` in another branch (same master card or same
 * product variant). With `create`, a copy of the card is created there.
 */
export async function counterpartItem(trx: Tx, tenantId: string, itemId: string, branchId: string, create = false): Promise<string | null> {
  const it = await trx.selectFrom('inventory_items').selectAll().where('id', '=', itemId).executeTakeFirstOrThrow();
  if (it.branch_id === branchId) return it.id;
  const found = await trx.selectFrom('inventory_items').select('id').where('branch_id', '=', branchId)
    .where((eb) => eb.or([eb('master_id', '=', it.master_id), ...(it.variant_id ? [eb('variant_id', '=', it.variant_id)] : [])]))
    .orderBy('created_at').executeTakeFirst();
  if (found || !create) return found?.id ?? null;
  const row = await trx.insertInto('inventory_items').values({
    tenant_id: tenantId, branch_id: branchId, variant_id: it.variant_id, name: it.name, kind: it.kind, unit: it.unit,
    low_stock_threshold: it.low_stock_threshold, cost_per_unit_minor: it.cost_per_unit_minor, code: it.code, barcode: it.barcode,
    category: it.category, description: it.description, image_asset_id: it.image_asset_id, storage_unit: it.storage_unit,
    conversion_factor: it.conversion_factor, is_tool: it.is_tool, freelancer_price_minor: it.freelancer_price_minor,
    supplier_id: it.supplier_id, track_batches: it.track_batches, track_expiry: it.track_expiry, master_id: it.master_id,
  }).returning('id').executeTakeFirstOrThrow();
  return row.id;
}
