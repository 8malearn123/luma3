import type { Tx } from '../../db/client';
import { post, type Account, type Line } from '../finance/journal';
import type { StockKind } from './stock';

/**
 * Inventory ↔ accounting (operational ledger, D15).
 *
 * Every costed stock movement posts its effect once (ref 'stock_movement',
 * movement id), at the cost frozen on the movement:
 *
 *   inbound  Dr inventory          Cr <counter>
 *   outbound Dr <counter>          Cr inventory
 *
 *   kind                         counter account
 *   opening                      owner_equity
 *   receipt                      goods_received_not_invoiced (cleared by the supplier invoice)
 *   sale / return                cogs
 *   consumption / return_from_use material_costs
 *   waste / adjustment / count_adjustment  inventory_shrinkage (gain = reverse)
 *   return_to_supplier           goods_received_not_invoiced, or accounts_payable once invoiced
 *   transfer_*, reservation, release   no entry
 *   correction                   reverse of the original movement's entry
 *
 * Supplier invoices and payments post in purchasing.ts. This is not a full
 * accounting system: no period close of inventory, no landed costs.
 */
const COUNTER: Partial<Record<StockKind, Account>> = {
  opening: 'owner_equity',
  receipt: 'goods_received_not_invoiced',
  sale: 'cogs',
  return: 'cogs',
  consumption: 'material_costs',
  return_from_use: 'material_costs',
  waste: 'inventory_shrinkage',
  adjustment: 'inventory_shrinkage',
  count_adjustment: 'inventory_shrinkage',
  return_to_supplier: 'goods_received_not_invoiced',
};

export function movementLines(kind: StockKind, total: number, counter?: Account): Line[] | null {
  const acct = kind === 'return_to_supplier' && counter ? counter : COUNTER[kind];
  if (!acct || !total) return null;
  const amt = Math.abs(total);
  return total > 0
    ? [{ account: 'inventory', debit: amt }, { account: acct, credit: amt }]
    : [{ account: acct, debit: amt }, { account: 'inventory', credit: amt }];
}

export async function postMovementJournal(trx: Tx, tenantId: string, mv: {
  id: string; kind: StockKind; total: number; reversalOf: string | null; counter?: Account; memo?: string; actorUserId: string | null;
}) {
  const lines = movementLines(mv.kind, mv.total, mv.counter);
  if (!lines) return null;
  let reversesGroupId: string | null = null;
  if (mv.reversalOf) {
    const orig = await trx.selectFrom('financial_entries').select('entry_group_id').where('tenant_id', '=', tenantId)
      .where('ref_type', '=', 'stock_movement').where('ref_id', '=', mv.reversalOf).executeTakeFirst();
    reversesGroupId = orig?.entry_group_id ?? null;
  }
  return post(trx, tenantId, { type: 'stock_movement', id: mv.id }, lines, { createdBy: mv.actorUserId, reversesGroupId, memo: `${mv.kind}${mv.memo ? `: ${mv.memo}` : ''}` });
}

/** First known cost for stock already on hand (it had no value until now). */
export async function postValuation(trx: Tx, tenantId: string, movementId: string, amount: number, actorUserId: string | null, memo: string) {
  return post(trx, tenantId, { type: 'inventory_valuation', id: movementId }, [
    { account: 'inventory', debit: amount }, { account: 'owner_equity', credit: amount },
  ], { createdBy: actorUserId, memo: `opening valuation: ${memo}` });
}
