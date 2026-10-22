import { randomUUID } from 'node:crypto';
import type { Tx } from '../../db/client';

/**
 * Double-entry journal (append-only; balanced per group by a deferred DB
 * constraint). Accounting basis used by LUMA reports:
 *
 *  Booking prepayment captured  Dr provider_clearing      Cr customer_deposits        (liability until service)
 *  On-site collection           Dr cash_on_hand|provider_clearing  Cr customer_deposits|accounts_receivable
 *  Service completed            Dr customer_deposits (paid part) + Dr accounts_receivable (unpaid part)
 *                               Cr service_revenue (net) + Cr tax_payable
 *  Order paid                   Dr provider_clearing      Cr product_revenue (net) + Cr tax_payable
 *  Cost of goods (cost known)   Dr cogs                   Cr inventory
 *  Refund before service        Dr customer_deposits      Cr provider_clearing|cash_on_hand
 *  Refund after recognition     Dr refunds (contra-revenue)  Cr provider_clearing|cash_on_hand
 *  Late-cancellation fee kept   Dr customer_deposits      Cr service_revenue
 *  Commission earned            Dr commissions_expense    Cr commissions_payable
 *  Expense recorded             Dr operating_expenses     Cr cash_on_hand
 *  Gift card sold               Dr provider_clearing      Cr gift_card_liability
 *  Gift card redeemed           Dr gift_card_liability    Cr customer_deposits
 *
 * A collected deposit is NOT service revenue until the service is completed.
 * Corrections are new offsetting groups (reverses_group_id), never edits.
 */
export type Account =
  | 'cash_on_hand' | 'provider_clearing' | 'customer_deposits' | 'accounts_receivable' | 'service_revenue' | 'product_revenue'
  | 'gift_card_liability' | 'membership_liability' | 'discounts' | 'refunds' | 'provider_fees' | 'tax_payable' | 'cogs' | 'inventory'
  | 'material_costs' | 'commissions_expense' | 'commissions_payable' | 'operating_expenses' | 'owner_equity';

export type Line = { account: Account; debit?: number; credit?: number; memo?: string };

export async function post(trx: Tx, tenantId: string, ref: { type: string; id: string | null }, lines: Line[], opts: { occurredAt?: Date; createdBy?: string | null; reversesGroupId?: string | null; memo?: string } = {}) {
  const clean = lines
    .map((l) => ({ ...l, debit: Math.round(l.debit ?? 0), credit: Math.round(l.credit ?? 0) }))
    .filter((l) => l.debit > 0 || l.credit > 0);
  if (!clean.length) return null;
  const dr = clean.reduce((a, l) => a + l.debit, 0);
  const cr = clean.reduce((a, l) => a + l.credit, 0);
  if (dr !== cr) throw new Error(`unbalanced journal entry for ${ref.type}: ${dr} != ${cr}`);
  for (const l of clean) if (l.debit > 0 && l.credit > 0) throw new Error('a journal line is either debit or credit');
  const group = randomUUID();
  await trx.insertInto('financial_entries').values(clean.map((l) => ({
    tenant_id: tenantId, entry_group_id: group, account: l.account, debit_minor: l.debit, credit_minor: l.credit,
    ref_type: ref.type, ref_id: ref.id, reverses_group_id: opts.reversesGroupId ?? null, memo: l.memo ?? opts.memo ?? null,
    occurred_at: opts.occurredAt ?? new Date(), created_by: opts.createdBy ?? null,
  }))).execute();
  return group;
}

/** Splits a tax-inclusive or tax-exclusive gross into net + tax using the booking's snapshot rule. */
export function splitTax(grossMinor: number, taxMinor: number, totalMinor: number) {
  if (totalMinor <= 0 || taxMinor <= 0) return { net: grossMinor, tax: 0 };
  const tax = Math.round((grossMinor * taxMinor) / totalMinor);
  return { net: grossMinor - tax, tax };
}

/** Has a posting already been made for (refType, refId)? Used to keep postings exactly-once. */
export async function alreadyPosted(trx: Tx, tenantId: string, refType: string, refId: string) {
  const r = await trx.selectFrom('financial_entries').select('id').where('tenant_id', '=', tenantId).where('ref_type', '=', refType).where('ref_id', '=', refId).limit(1).executeTakeFirst();
  return !!r;
}
