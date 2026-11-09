import { sql } from 'kysely';
import type { z } from 'zod';
import { withTenant, type Tx } from '../../db/client';
import { Errors } from '../../http/errors';
import { audit, type AuditActor } from '../../infra/audit';
import { nextReadableNumber } from '../../infra/counters';
import { notifyCapability } from '../../infra/notify';
import { hasCapability, type TenantAccess } from '../../tenancy/access';
import { moveStock, primaryBranchId, tenantSlug } from './stock';
import { milli, round3 } from '@/shared/units';
import type { stockCountInput, stockCountLinesInput } from '@/shared/schemas/commerce';

/**
 * Physical stock counts (الجرد). A draft lists every active item of a branch;
 * staff enter what is on the shelf, item by item, possibly over several saves.
 * Applying the count is the single moment of truth:
 *  - the system quantity is read under a row lock at that moment, so sales or
 *    consumptions recorded while counting are not double-counted;
 *  - each difference becomes one 'adjustment' movement (ref_type stock_count),
 *    so the ledger, not the count, stays the source of stock;
 *  - lines left blank are not counted and change nothing;
 *  - a counted quantity below what is reserved for paid orders is refused
 *    (recount, or cancel those orders first), never silently clamped.
 * Differences above the count's tolerance notify inventory managers, and
 * finance when a cost is known.
 */
type Line = {
  inventory_item_id: string; name: string; kind: string; unit: string; sku: string | null;
  on_hand: number; reserved: number; cost_per_unit_minor: number | null;
  counted_quantity: number | null; system_quantity: number | null; variance: number | null; variance_cost_minor: number | null;
  counted_at: Date | null; flagged: boolean;
};

async function loadCount(trx: Tx, id: string, lock = false) {
  let q = trx.selectFrom('stock_counts').selectAll().where('id', '=', id);
  if (lock) q = q.forUpdate();
  const c = await q.executeTakeFirst();
  if (!c) throw Errors.notFound('stock_count');
  return c;
}

/** Beyond tolerance: |variance| > tolerance% of the system quantity (any difference when it was 0). */
export function isFlagged(system: number, variance: number, tolerancePct: number) {
  if (milli(variance) === 0) return false;
  if (milli(system) === 0 || tolerancePct === 0) return true;
  return Math.abs(variance) * 100 > tolerancePct * Math.abs(system);
}

async function loadLines(trx: Tx, access: TenantAccess, countId: string, tolerancePct: number): Promise<Line[]> {
  const rows = await trx.selectFrom('stock_count_lines as l').innerJoin('inventory_items as ii', 'ii.id', 'l.inventory_item_id')
    .leftJoin('product_variants as v', 'v.id', 'ii.variant_id')
    .select(['l.inventory_item_id', 'ii.name', 'ii.kind', 'ii.unit', 'v.sku', 'ii.on_hand', 'ii.reserved', 'ii.cost_per_unit_minor',
      'l.counted_quantity', 'l.system_quantity', 'l.variance', 'l.variance_cost_minor', 'l.counted_at'])
    .where('l.count_id', '=', countId).orderBy('ii.name').orderBy('ii.id').execute();
  const costs = hasCapability(access, 'costs.view');
  return rows.map((r) => {
    const n = (v: unknown) => (v == null ? null : Number(v));
    const variance = n(r.variance);
    return {
      ...r, on_hand: Number(r.on_hand), reserved: Number(r.reserved), counted_quantity: n(r.counted_quantity),
      system_quantity: n(r.system_quantity), variance,
      cost_per_unit_minor: costs ? n(r.cost_per_unit_minor) : null, variance_cost_minor: costs ? n(r.variance_cost_minor) : null,
      flagged: variance != null && isFlagged(Number(r.system_quantity), variance, tolerancePct),
    };
  });
}

function summarize(lines: Line[]) {
  const counted = lines.filter((l) => l.counted_quantity != null).length;
  const diff = lines.filter((l) => l.variance != null && milli(l.variance) !== 0);
  return {
    lines: lines.length, counted, uncounted: lines.length - counted,
    shortages: diff.filter((l) => l.variance! < 0).length, surpluses: diff.filter((l) => l.variance! > 0).length,
    flagged: lines.filter((l) => l.flagged).length,
  };
}

function serializeCount(c: Awaited<ReturnType<typeof loadCount>>) {
  return { ...c, tolerance_pct: Number(c.tolerance_pct) };
}

export async function listCounts(access: TenantAccess) {
  return withTenant(access.tenantId, async (trx) => {
    const rows = await trx.selectFrom('stock_counts as c').innerJoin('branches as b', 'b.id', 'c.branch_id')
      .select(['c.id', 'c.number', 'c.status', 'c.note', 'c.tolerance_pct', 'c.created_at', 'c.applied_at', 'c.branch_id', 'b.name as branch_name',
        sql<number>`(select count(*)::int from stock_count_lines l where l.count_id = c.id)`.as('lines'),
        sql<number>`(select count(*)::int from stock_count_lines l where l.count_id = c.id and l.counted_quantity is not null)`.as('counted'),
        sql<number>`(select count(*)::int from stock_count_lines l where l.count_id = c.id and l.variance <> 0)`.as('differences'),
      ])
      .orderBy('c.created_at', 'desc').limit(100).execute();
    return rows.map((r) => ({ ...r, tolerance_pct: Number(r.tolerance_pct) }));
  });
}

export async function getCount(access: TenantAccess, id: string) {
  return withTenant(access.tenantId, async (trx) => {
    const c = await loadCount(trx, id);
    const lines = await loadLines(trx, access, id, Number(c.tolerance_pct));
    return { ...serializeCount(c), summary: summarize(lines), lines };
  });
}

export async function createCount(access: TenantAccess, actor: AuditActor, input: z.infer<typeof stockCountInput>) {
  return withTenant(access.tenantId, async (trx) => {
    const branchId = input.branch_id ?? await primaryBranchId(trx, access.tenantId);
    const open = await trx.selectFrom('stock_counts').select(['id', 'number']).where('branch_id', '=', branchId).where('status', '=', 'draft').executeTakeFirst();
    if (open) throw Errors.conflict('count_in_progress', 'A count is already open for this branch', { id: open.id, number: open.number });
    let items = trx.selectFrom('inventory_items').select('id').where('branch_id', '=', branchId).where('is_active', '=', true);
    if (input.kind === 'retail') items = items.where('kind', 'in', ['retail', 'both']);
    if (input.kind === 'material') items = items.where('kind', 'in', ['material', 'both']);
    const ids = await items.execute();
    if (!ids.length) throw Errors.invalid('nothing_to_count', 'This branch has no active items to count');
    const number = await nextReadableNumber(trx, access.tenantId, 'stock_count');
    const c = await trx.insertInto('stock_counts').values({
      tenant_id: access.tenantId, branch_id: branchId, number, note: input.note || null, tolerance_pct: input.tolerance_pct, created_by: actor.userId,
    }).returning('id').executeTakeFirstOrThrow();
    await trx.insertInto('stock_count_lines').values(ids.map((i) => ({ tenant_id: access.tenantId, count_id: c.id, inventory_item_id: i.id }))).execute();
    await audit(trx, actor, 'inventory.count_started', { tenantId: access.tenantId, targetType: 'stock_count', targetId: c.id, data: { number, items: ids.length, kind: input.kind } });
    return c;
  });
}

export async function saveCountLines(access: TenantAccess, actor: AuditActor, id: string, input: z.infer<typeof stockCountLinesInput>) {
  return withTenant(access.tenantId, async (trx) => {
    const c = await loadCount(trx, id, true);
    if (c.status !== 'draft') throw Errors.conflict('count_closed', 'This count is no longer open');
    if (c.version !== input.version) throw Errors.versionConflict(c.version);
    const units = new Map((await trx.selectFrom('stock_count_lines as l').innerJoin('inventory_items as ii', 'ii.id', 'l.inventory_item_id')
      .select(['l.inventory_item_id', 'ii.unit']).where('l.count_id', '=', id).execute()).map((r) => [r.inventory_item_id, r.unit]));
    const now = new Date();
    for (const l of input.lines) {
      const unit = units.get(l.inventory_item_id);
      if (!unit) throw Errors.invalid('not_in_count', 'This item is not part of the count', { inventory_item_id: l.inventory_item_id });
      if (unit === 'piece' && l.counted_quantity != null && !Number.isInteger(l.counted_quantity)) {
        throw Errors.invalid('whole_units_required', 'Pieces must be whole numbers', { inventory_item_id: l.inventory_item_id });
      }
      await trx.updateTable('stock_count_lines').set({
        counted_quantity: l.counted_quantity, counted_by: l.counted_quantity == null ? null : actor.userId, counted_at: l.counted_quantity == null ? null : now,
      }).where('count_id', '=', id).where('inventory_item_id', '=', l.inventory_item_id).execute();
    }
    await trx.updateTable('stock_counts').set({ version: sql`version + 1`, ...(input.note !== undefined ? { note: input.note || null } : {}) }).where('id', '=', id).execute();
    const fresh = await loadCount(trx, id);
    const lines = await loadLines(trx, access, id, Number(fresh.tolerance_pct));
    return { ...serializeCount(fresh), summary: summarize(lines), lines };
  });
}

export async function cancelCount(access: TenantAccess, actor: AuditActor, id: string) {
  return withTenant(access.tenantId, async (trx) => {
    const c = await loadCount(trx, id, true);
    if (c.status !== 'draft') throw Errors.conflict('count_closed', 'This count is no longer open');
    await trx.updateTable('stock_counts').set({ status: 'cancelled', version: sql`version + 1` }).where('id', '=', id).execute();
    await audit(trx, actor, 'inventory.count_cancelled', { tenantId: access.tenantId, targetType: 'stock_count', targetId: id, data: { number: c.number } });
    return { id, status: 'cancelled' as const };
  });
}

export async function applyCount(access: TenantAccess, actor: AuditActor, id: string, version: number) {
  return withTenant(access.tenantId, async (trx) => {
    const c = await loadCount(trx, id, true);
    if (c.status !== 'draft') throw Errors.conflict('count_closed', 'This count is no longer open');
    if (c.version !== version) throw Errors.versionConflict(c.version);
    const counted = await trx.selectFrom('stock_count_lines as l').innerJoin('inventory_items as ii', 'ii.id', 'l.inventory_item_id')
      .select(['l.id', 'l.inventory_item_id', 'l.counted_quantity', 'ii.name'])
      .where('l.count_id', '=', id).where('l.counted_quantity', 'is not', null).orderBy('l.inventory_item_id').execute();
    if (!counted.length) throw Errors.invalid('nothing_counted', 'Enter at least one counted quantity');
    // Lock the items in a stable order, then read the system quantity under the lock.
    const items = new Map((await trx.selectFrom('inventory_items').select(['id', 'on_hand', 'reserved', 'cost_per_unit_minor'])
      .where('id', 'in', counted.map((l) => l.inventory_item_id)).orderBy('id').forUpdate().execute()).map((i) => [i.id, i]));
    const belowReserved = counted.filter((l) => milli(Number(l.counted_quantity)) < milli(Number(items.get(l.inventory_item_id)!.reserved)));
    if (belowReserved.length) {
      throw Errors.conflict('counted_below_reserved', 'Some counted quantities are below what is reserved for paid orders', {
        items: belowReserved.map((l) => ({ inventory_item_id: l.inventory_item_id, name: l.name, counted: Number(l.counted_quantity), reserved: Number(items.get(l.inventory_item_id)!.reserved) })),
      });
    }
    const tolerance = Number(c.tolerance_pct);
    const flagged: Array<{ name: string; system: number; counted: number; variance: number; cost: number | null }> = [];
    let shortageCost = 0, surplusCost = 0, costKnown = true;
    for (const l of counted) {
      const it = items.get(l.inventory_item_id)!;
      const system = Number(it.on_hand), countedQty = Number(l.counted_quantity);
      const variance = round3(countedQty - system);
      const cost = it.cost_per_unit_minor == null ? null : Math.round(variance * Number(it.cost_per_unit_minor));
      if (milli(variance) !== 0) {
        const r = await moveStock(trx, access.tenantId, l.inventory_item_id, {
          kind: 'adjustment', quantity: variance, dOnHand: variance, dReserved: 0, reason: `جرد ${c.number} / stock count`,
          refType: 'stock_count', refId: id, actorUserId: actor.userId,
        });
        if (!r) throw Errors.conflict('concurrent_update', 'Stock changed while applying the count; retry');
        if (cost == null) costKnown = false; else if (cost < 0) shortageCost += -cost; else surplusCost += cost;
      }
      await trx.updateTable('stock_count_lines').set({ system_quantity: system, variance, variance_cost_minor: cost }).where('id', '=', l.id).execute();
      if (isFlagged(system, variance, tolerance)) flagged.push({ name: l.name, system, counted: countedQty, variance, cost });
    }
    await trx.updateTable('stock_counts').set({ status: 'applied', applied_at: new Date(), applied_by: actor.userId, version: sql`version + 1` }).where('id', '=', id).execute();
    await audit(trx, actor, 'inventory.count_applied', {
      tenantId: access.tenantId, targetType: 'stock_count', targetId: id,
      data: { number: c.number, counted: counted.length, flagged: flagged.length, shortage_cost_minor: shortageCost, surplus_cost_minor: surplusCost },
    });
    if (flagged.length) await varianceAlert(trx, access.tenantId, id, c.number, flagged, { shortageCost, surplusCost, costKnown });
    return getCountIn(trx, access, id);
  });
}

async function getCountIn(trx: Tx, access: TenantAccess, id: string) {
  const c = await loadCount(trx, id);
  const lines = await loadLines(trx, access, id, Number(c.tolerance_pct));
  return { ...serializeCount(c), summary: summarize(lines), lines };
}

async function varianceAlert(trx: Tx, tenantId: string, countId: string, number: string,
  flagged: Array<{ name: string; variance: number }>, money: { shortageCost: number; surplusCost: number; costKnown: boolean }) {
  const slug = await tenantSlug(trx, tenantId);
  const short = flagged.filter((f) => f.variance < 0).length, over = flagged.length - short;
  const sample = flagged.slice(0, 3);
  const n = {
    kind: 'inventory.count_variance',
    title_ar: `فروقات في الجرد ${number}: ${flagged.length} صنف`,
    title_en: `Stock count ${number}: ${flagged.length} item(s) differ`,
    body_ar: `عجز في ${short} وزيادة في ${over}. ${sample.map((f) => `${f.name} (${f.variance > 0 ? '+' : ''}${f.variance})`).join('، ')}${flagged.length > 3 ? '…' : ''}`,
    body_en: `${short} short, ${over} over. ${sample.map((f) => `${f.name} (${f.variance > 0 ? '+' : ''}${f.variance})`).join(', ')}${flagged.length > 3 ? '…' : ''}`,
    target_path: slug ? `/app/${slug}/inventory?tab=counts&count=${countId}` : undefined,
    data: { stock_count_id: countId, flagged: flagged.length, shortages: short, surpluses: over, ...(money.costKnown ? { shortage_cost_minor: money.shortageCost, surplus_cost_minor: money.surplusCost } : {}) },
    dedupe_key: `count_variance:${countId}`,
  };
  await notifyCapability(trx, tenantId, ['inventory.manage', 'finance.view'], n);
}
