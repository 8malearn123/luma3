import { sql } from 'kysely';
import { withSystem } from '../../db/client';
import { notifyCapability } from '../../infra/notify';

/**
 * Stock balance check. `inventory_items.on_hand/reserved` are a cache of the
 * append-only `stock_movements` ledger (see stock.ts), and `reserved` must equal
 * the open order reservations. Every write keeps them in step inside one
 * transaction, so a difference means something bypassed moveStock (a manual
 * SQL fix, an import, a bug). Three comparisons per active item:
 *  - on_hand  vs the sum of the ledger's on_hand deltas;
 *  - reserved vs the sum of the ledger's reserved deltas;
 *  - reserved vs the sum of active stock_reservations.
 * Deltas follow stock.ts's sign convention (sale: on_hand += q, reserved += q
 * with q < 0; release: reserved -= q). Sums are used rather than the latest
 * on_hand_after because movements of one transaction share created_at.
 * Mismatches are reported, never auto-corrected: a person decides, then records
 * an adjustment with a reason. Alerts repeat at most once a day per item.
 */
export type StockMismatch = {
  item_id: string; tenant_id: string; slug: string; name: string;
  on_hand: number; ledger_on_hand: number; reserved: number; ledger_reserved: number; open_reservations: number;
};

export async function findStockMismatches(tenantId?: string): Promise<StockMismatch[]> {
  return withSystem('stock balance check: cache vs ledger vs reservations', async (trx) => {
    const res = await sql<StockMismatch>`
      select ii.id as item_id, ii.tenant_id, t.slug::text as slug, ii.name,
        ii.on_hand::float8 as on_hand, coalesce(m.on_hand_after, 0)::float8 as ledger_on_hand,
        ii.reserved::float8 as reserved, coalesce(m.reserved_after, 0)::float8 as ledger_reserved,
        coalesce(r.qty, 0)::float8 as open_reservations
      from inventory_items ii
      join tenants t on t.id = ii.tenant_id
      left join lateral (
        select
          sum(case when sm.kind in ('reservation', 'release') then 0 else sm.quantity end) as on_hand_after,
          sum(case sm.kind when 'reservation' then sm.quantity when 'sale' then sm.quantity when 'release' then -sm.quantity else 0 end) as reserved_after
        from stock_movements sm where sm.inventory_item_id = ii.id
      ) m on true
      left join lateral (
        select sum(sr.quantity) as qty from stock_reservations sr
        where sr.inventory_item_id = ii.id and sr.status = 'active'
      ) r on true
      where ii.is_active ${tenantId ? sql`and ii.tenant_id = ${tenantId}` : sql``}
        and (ii.on_hand <> coalesce(m.on_hand_after, 0)
          or ii.reserved <> coalesce(m.reserved_after, 0)
          or ii.reserved <> coalesce(r.qty, 0))
      order by ii.tenant_id, ii.name
      limit 2000`.execute(trx);
    return res.rows;
  });
}

export async function runStockBalanceCheck(now = new Date()) {
  const found = await findStockMismatches();
  const day = now.toISOString().slice(0, 10);
  for (const m of found) {
    const ledgerDiff = m.on_hand !== m.ledger_on_hand || m.reserved !== m.ledger_reserved;
    await withSystem('notify about a stock balance mismatch', (trx) => notifyCapability(trx, m.tenant_id, ['inventory.manage'], {
      kind: 'inventory.balance_mismatch',
      title_ar: `عدم توازن في المخزون: ${m.name}`,
      title_en: `Stock out of balance: ${m.name}`,
      body_ar: ledgerDiff
        ? `الرصيد المسجل ${m.on_hand} (محجوز ${m.reserved}) لا يطابق سجل الحركات ${m.ledger_on_hand} (محجوز ${m.ledger_reserved}). راجع الحركات وسجّل تسوية بسبب واضح.`
        : `الكمية المحجوزة ${m.reserved} لا تطابق حجوزات الطلبات المفتوحة ${m.open_reservations}.`,
      body_en: ledgerDiff
        ? `Recorded stock ${m.on_hand} (reserved ${m.reserved}) does not match the movement ledger ${m.ledger_on_hand} (reserved ${m.ledger_reserved}). Review the movements and record an adjustment with a reason.`
        : `Reserved quantity ${m.reserved} does not match open order reservations ${m.open_reservations}.`,
      target_path: `/app/${m.slug}/inventory?item=${m.item_id}`,
      data: { inventory_item_id: m.item_id, on_hand: m.on_hand, ledger_on_hand: m.ledger_on_hand, reserved: m.reserved, ledger_reserved: m.ledger_reserved, open_reservations: m.open_reservations },
      dedupe_key: `stock_mismatch:${m.item_id}:${day}`,
    }));
  }
  return { mismatches: found.length };
}
