import { sql, type Tx } from '../../db/client';
import { Errors } from '../../http/errors';
import { notifyCapability } from '../../infra/notify';

/**
 * Stock ledger primitives. `inventory_items.on_hand/reserved` are a cache kept
 * in the same transaction as each append-only `stock_movements` row.
 *
 * Every change is ONE guarded UPDATE (`… WHERE on_hand + Δ >= 0 AND reserved + Δr
 * <= on_hand + Δ`), so two concurrent reservations of the last unit cannot both
 * succeed; the DB CHECKs (on_hand >= 0, reserved <= on_hand) are the backstop.
 *
 * Movement quantity sign convention (relative to the item's unit):
 *   receipt  +q  on_hand += q            reservation +q  reserved += q
 *   release  +q  reserved -= q           sale        -q  on_hand -= q, reserved -= q
 *   return   +q  on_hand += q            consumption -q  on_hand -= q
 *   adjustment ±q on_hand += q
 * Movements tied to a business event (reservation/sale/release/return/
 * consumption with ref_id) are unique per (item, kind, ref_type, ref_id); the
 * callers' status guards make that index a never-hit backstop.
 */
export type StockKind = 'receipt' | 'reservation' | 'sale' | 'release' | 'return' | 'adjustment' | 'consumption';

export type MoveResult = { onHand: number; reserved: number; available: number };

export async function moveStock(trx: Tx, tenantId: string, itemId: string, m: {
  kind: StockKind;
  quantity: number;
  dOnHand: number;
  dReserved: number;
  reason?: string | null;
  refType?: string | null;
  refId?: string | null;
  actorUserId?: string | null;
  requireActive?: boolean;
}): Promise<MoveResult | null> {
  const res = await sql<{ on_hand: number; reserved: number; low_stock_threshold: number | null; name: string; prev_available: number }>`
    update inventory_items set on_hand = on_hand + ${m.dOnHand}::numeric, reserved = reserved + ${m.dReserved}::numeric
    where id = ${itemId} and tenant_id = ${tenantId}
      and on_hand + ${m.dOnHand}::numeric >= 0
      and reserved + ${m.dReserved}::numeric >= 0
      and reserved + ${m.dReserved}::numeric <= on_hand + ${m.dOnHand}::numeric
      ${m.requireActive ? sql`and is_active` : sql``}
    returning on_hand, reserved, low_stock_threshold, name,
      (on_hand - reserved) - (${m.dOnHand}::numeric - ${m.dReserved}::numeric) as prev_available`.execute(trx);
  const row = res.rows[0];
  if (!row) return null;
  await trx.insertInto('stock_movements').values({
    tenant_id: tenantId, inventory_item_id: itemId, kind: m.kind, quantity: m.quantity,
    on_hand_after: row.on_hand, reserved_after: row.reserved, reason: m.reason ?? null,
    ref_type: m.refType ?? null, ref_id: m.refId ?? null, actor_user_id: m.actorUserId ?? null,
  }).execute();
  const available = Number(row.on_hand) - Number(row.reserved);
  if (row.low_stock_threshold != null && available <= Number(row.low_stock_threshold) && available < Number(row.prev_available)) {
    await lowStockAlert(trx, tenantId, itemId, row.name, available);
  }
  return { onHand: Number(row.on_hand), reserved: Number(row.reserved), available };
}

/** Deduplicated per item per day (notifications unique on (user_id, dedupe_key)). */
async function lowStockAlert(trx: Tx, tenantId: string, itemId: string, name: string, available: number) {
  const slug = await tenantSlug(trx, tenantId);
  const day = new Date().toISOString().slice(0, 10);
  await notifyCapability(trx, tenantId, ['inventory.manage'], {
    kind: 'inventory.low_stock',
    title_ar: `مخزون منخفض: ${name}`,
    title_en: `Low stock: ${name}`,
    body_ar: `المتاح الآن ${available}.`,
    body_en: `Available now: ${available}.`,
    target_path: slug ? `/app/${slug}/inventory?item=${itemId}` : undefined,
    data: { inventory_item_id: itemId, available },
    dedupe_key: `low_stock:${itemId}:${day}`,
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
