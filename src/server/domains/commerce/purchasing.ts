import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { z } from 'zod';
import { withTenant, type Tx } from '../../db/client';
import { Errors } from '../../http/errors';
import { audit, type AuditActor } from '../../infra/audit';
import { nextReadableNumber } from '../../infra/counters';
import { idempotent, requestHash } from '../../infra/idempotency';
import { hasCapability, type TenantAccess } from '../../tenancy/access';
import { alreadyPosted, post, type Line } from '../finance/journal';
import { defaultLocationId, moveStock, primaryBranchId } from './stock';
import { loadLocation } from './locations';
import { milli, round3 } from '@/shared/units';
import type { invoiceInput, invoiceLinkInput, paymentInput, receiptInput, supplierInput, supplierPatch, supplierReturnInput } from '@/shared/schemas/inventory';

/**
 * Purchasing and accounts payable (requirement 7). Separate documents, never
 * one operation:
 *  - purchase receipt (RCV-…): goods into a location. Posting adds stock
 *    exactly once (status guard + one movement per line, unique per line) and
 *    posts Dr inventory / Cr goods_received_not_invoiced at the receipt cost.
 *  - supplier invoice: money owed. Lines are matched to received lines
 *    (partial allowed) through supplier_invoice_receipt_links. LINKING NEVER
 *    MOVES STOCK. Posting: Dr goods_received_not_invoiced for the matched
 *    quantity at receipt cost, the price difference to inventory (stock still
 *    on hand, re-averaging it) or to cost of goods / materials (already used),
 *    unmatched stock lines to goods_received_not_invoiced (goods invoiced
 *    before they arrive), non-stock lines to operating expenses, tax to
 *    input_tax; Cr accounts_payable.
 *  - supplier payment: Dr accounts_payable / Cr cash_on_hand | bank.
 *  - return to supplier: return_to_supplier movement at the weighted average,
 *    Dr accounts_payable (invoiced) or goods_received_not_invoiced / Cr inventory.
 * A posted invoice is not voided here (credit notes from suppliers are not
 * modelled yet); a draft can be voided.
 */
const num = (v: unknown) => (v == null ? null : Number(v));

// ── Suppliers ───────────────────────────────────────────────────────────────
export async function listSuppliers(access: TenantAccess) {
  return withTenant(access.tenantId, async (trx) => {
    const rows = await trx.selectFrom('suppliers as s').selectAll('s').select([
      sql<number>`coalesce((select sum(i.total_minor) from supplier_invoices i where i.supplier_id = s.id and i.status = 'posted'), 0)::bigint`.as('invoiced_minor'),
      sql<number>`coalesce((select sum(p.amount_minor) from supplier_payments p where p.supplier_id = s.id), 0)::bigint`.as('paid_minor'),
    ]).orderBy('s.name').execute();
    const money = hasCapability(access, ['purchasing.manage', 'purchasing.pay', 'costs.view']);
    return rows.map(({ invoiced_minor, paid_minor, ...r }) => ({ ...r, ...(money ? { invoiced_minor, paid_minor, balance_minor: invoiced_minor - paid_minor } : {}) }));
  });
}

export async function createSupplier(access: TenantAccess, actor: AuditActor, input: z.infer<typeof supplierInput>) {
  return withTenant(access.tenantId, async (trx) => {
    const row = await trx.insertInto('suppliers').values({ tenant_id: access.tenantId, ...input, created_by: actor.userId }).returningAll().executeTakeFirstOrThrow();
    await audit(trx, actor, 'purchasing.supplier_created', { tenantId: access.tenantId, targetType: 'supplier', targetId: row.id, data: { name: input.name } });
    return row;
  });
}

export async function updateSupplier(access: TenantAccess, actor: AuditActor, id: string, patch: z.infer<typeof supplierPatch>) {
  return withTenant(access.tenantId, async (trx) => {
    const row = await trx.updateTable('suppliers').set(patch).where('id', '=', id).returningAll().executeTakeFirst();
    if (!row) throw Errors.notFound('supplier');
    await audit(trx, actor, 'purchasing.supplier_updated', { tenantId: access.tenantId, targetType: 'supplier', targetId: id, data: patch });
    return row;
  });
}

async function requireSupplier(trx: Tx, id: string) {
  const s = await trx.selectFrom('suppliers').select(['id', 'is_active']).where('id', '=', id).executeTakeFirst();
  if (!s) throw Errors.notFound('supplier');
  return s;
}

// ── Receipts ────────────────────────────────────────────────────────────────
export async function getReceiptIn(trx: Tx, access: TenantAccess, id: string) {
  const r = await trx.selectFrom('purchase_receipts as r').leftJoin('suppliers as s', 's.id', 'r.supplier_id').innerJoin('stock_locations as l', 'l.id', 'r.location_id')
    .selectAll('r').select(['s.name as supplier_name', 'l.name as location_name']).where('r.id', '=', id).executeTakeFirst();
  if (!r) throw Errors.notFound('purchase_receipt');
  const lines = await trx.selectFrom('purchase_receipt_lines as l').innerJoin('inventory_items as i', 'i.id', 'l.inventory_item_id')
    .select(['l.id', 'l.inventory_item_id', 'i.name', 'i.unit', 'i.storage_unit', 'l.quantity', 'l.entered_quantity', 'l.entered_uom', 'l.unit_cost_minor', 'l.batch_no', 'l.expiry_date', 'l.movement_id',
      sql<number>`coalesce((select sum(k.quantity) from supplier_invoice_receipt_links k join supplier_invoice_lines il on il.id = k.invoice_line_id join supplier_invoices iv on iv.id = il.invoice_id where k.receipt_line_id = l.id and iv.status <> 'void'), 0)`.as('invoiced_qty')])
    .where('l.receipt_id', '=', id).orderBy('l.created_at').execute();
  const costs = hasCapability(access, 'costs.view');
  return {
    ...r,
    lines: lines.map(({ unit_cost_minor, ...l }) => ({
      ...l, quantity: Number(l.quantity), entered_quantity: Number(l.entered_quantity), invoiced_qty: Number(l.invoiced_qty),
      not_invoiced_qty: round3(Number(l.quantity) - Number(l.invoiced_qty)), ...(costs ? { unit_cost_minor: num(unit_cost_minor) } : {}),
    })),
  };
}

export async function getReceipt(access: TenantAccess, id: string) {
  return withTenant(access.tenantId, (trx) => getReceiptIn(trx, access, id));
}

export async function listReceipts(access: TenantAccess, q: { status?: string; not_invoiced?: boolean } = {}) {
  return withTenant(access.tenantId, async (trx) => {
    let s = trx.selectFrom('purchase_receipts as r').leftJoin('suppliers as s', 's.id', 'r.supplier_id').innerJoin('stock_locations as l', 'l.id', 'r.location_id')
      .select(['r.id', 'r.number', 'r.status', 'r.received_on', 'r.reference', 'r.posted_at', 'r.version', 's.name as supplier_name', 'r.supplier_id', 'l.name as location_name',
        sql<number>`(select count(*)::int from purchase_receipt_lines pl where pl.receipt_id = r.id)`.as('lines'),
        sql<number>`(select coalesce(sum(pl.quantity), 0) from purchase_receipt_lines pl where pl.receipt_id = r.id)`.as('received_qty'),
        sql<number>`(select coalesce(sum(k.quantity), 0) from purchase_receipt_lines pl join supplier_invoice_receipt_links k on k.receipt_line_id = pl.id
          join supplier_invoice_lines il on il.id = k.invoice_line_id join supplier_invoices iv on iv.id = il.invoice_id where pl.receipt_id = r.id and iv.status <> 'void')`.as('invoiced_qty')]);
    if (q.status) s = s.where('r.status', '=', q.status);
    const rows = (await s.orderBy('r.received_on', 'desc').orderBy('r.created_at', 'desc').limit(200).execute()).map((r) => {
      const rec = Number(r.received_qty), inv = Number(r.invoiced_qty);
      return { ...r, received_qty: rec, invoiced_qty: inv, matching: inv <= 0 ? 'not_invoiced' : milli(inv) < milli(rec) ? 'partly_invoiced' : 'invoiced' };
    });
    return q.not_invoiced ? rows.filter((r) => r.status === 'posted' && r.matching !== 'invoiced') : rows;
  });
}

async function postReceiptIn(trx: Tx, access: TenantAccess, actor: AuditActor, id: string) {
  const r = await trx.selectFrom('purchase_receipts').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
  if (!r) throw Errors.notFound('purchase_receipt');
  if (r.status !== 'draft') throw Errors.conflict('receipt_not_draft', 'This receipt was already posted or voided');
  const lines = await trx.selectFrom('purchase_receipt_lines as l').innerJoin('inventory_items as i', 'i.id', 'l.inventory_item_id')
    .select(['l.id', 'l.inventory_item_id', 'l.quantity', 'l.unit_cost_minor', 'l.batch_no', 'l.expiry_date', 'i.track_batches', 'i.track_expiry', 'i.name'])
    .where('l.receipt_id', '=', id).orderBy('l.inventory_item_id').execute();
  for (const l of lines) {
    if (l.track_expiry && !l.expiry_date) throw Errors.invalid('expiry_required', `${l.name}: expiry date required`, { inventory_item_id: l.inventory_item_id });
    const q = Number(l.quantity);
    const mv = await moveStock(trx, access.tenantId, l.inventory_item_id, {
      kind: 'receipt', quantity: q, dOnHand: q, dReserved: 0, reason: r.number, refType: 'purchase_receipt_line', refId: l.id,
      actorUserId: actor.userId, locationId: r.location_id, unitCostMinor: num(l.unit_cost_minor),
      batch: l.track_batches && l.batch_no ? { batchNo: l.batch_no, expiryDate: l.expiry_date } : null,
      documentType: 'purchase_receipt', documentId: id,
    });
    if (!mv) throw Errors.conflict('concurrent_update');
    await trx.updateTable('purchase_receipt_lines').set({ movement_id: mv.movementId, ...(l.unit_cost_minor == null && mv.unitCostMinor != null ? { unit_cost_minor: mv.unitCostMinor } : {}) }).where('id', '=', l.id).execute();
  }
  await trx.updateTable('purchase_receipts').set({ status: 'posted', posted_at: new Date(), posted_by: actor.userId, version: r.version + 1 }).where('id', '=', id).execute();
  await audit(trx, actor, 'purchasing.receipt_posted', { tenantId: access.tenantId, targetType: 'purchase_receipt', targetId: id, data: { number: r.number, lines: lines.length } });
}

export async function createReceipt(access: TenantAccess, actor: AuditActor, input: z.infer<typeof receiptInput>, idempotencyKey: string | null) {
  const anyCost = input.lines.some((l) => l.unit_cost_minor != null);
  if (anyCost && !hasCapability(access, 'costs.view')) throw Errors.forbidden('You cannot set confidential costs');
  return withTenant(access.tenantId, async (trx) => {
    const run = async () => {
      if (input.supplier_id) await requireSupplier(trx, input.supplier_id);
      const locationId = input.location_id ?? await defaultLocationId(trx, access.tenantId, await primaryBranchId(trx, access.tenantId));
      const loc = await loadLocation(trx, locationId);
      if (!loc.is_active) throw Errors.invalid('location_inactive');
      const ids = [...new Set(input.lines.map((l) => l.inventory_item_id))];
      const items = await trx.selectFrom('inventory_items').select(['id', 'branch_id', 'unit', 'conversion_factor', 'track_batches']).where('id', 'in', ids).execute();
      if (items.length !== ids.length) throw Errors.notFound('inventory_item');
      const number = await nextReadableNumber(trx, access.tenantId, 'purchase_receipt');
      const rec = await trx.insertInto('purchase_receipts').values({
        tenant_id: access.tenantId, number, supplier_id: input.supplier_id ?? null, location_id: loc.id, received_on: input.received_on,
        reference: input.reference ?? null, note: input.note ?? null, created_by: actor.userId,
      }).returning('id').executeTakeFirstOrThrow();
      const rows = input.lines.map((l) => {
        const it = items.find((i) => i.id === l.inventory_item_id)!;
        if (it.branch_id !== loc.branch_id) throw Errors.invalid('location_branch_mismatch', 'Receive an item into a location of its own branch');
        let factor = 1;
        if (l.uom === 'storage') {
          if (it.conversion_factor == null) throw Errors.invalid('no_conversion_factor', 'This item has no approved storage-unit factor');
          factor = Number(it.conversion_factor);
        }
        const qty = round3(l.quantity * factor);
        if (it.unit === 'piece' && !Number.isInteger(qty)) throw Errors.invalid('whole_units_required');
        if ((l.batch_no || l.expiry_date) && !it.track_batches) throw Errors.invalid('batches_not_tracked');
        return {
          tenant_id: access.tenantId, receipt_id: rec.id, inventory_item_id: l.inventory_item_id, quantity: qty, entered_quantity: l.quantity, entered_uom: l.uom,
          unit_cost_minor: l.unit_cost_minor == null ? null : Math.round((l.unit_cost_minor / factor) * 10000) / 10000,
          batch_no: l.batch_no ?? null, expiry_date: l.expiry_date ?? null,
        };
      });
      await trx.insertInto('purchase_receipt_lines').values(rows).execute();
      await audit(trx, actor, 'purchasing.receipt_created', { tenantId: access.tenantId, targetType: 'purchase_receipt', targetId: rec.id, data: { number, lines: rows.length } });
      if (input.post) await postReceiptIn(trx, access, actor, rec.id);
      return { status: 201, body: await getReceiptIn(trx, access, rec.id) };
    };
    if (!idempotencyKey) return (await run()).body;
    return (await idempotent(trx, { scope: `tenant:${access.tenantId}`, operation: 'purchasing.receipt', key: idempotencyKey, hash: requestHash(input) }, run)).body;
  });
}

export async function postReceipt(access: TenantAccess, actor: AuditActor, id: string) {
  return withTenant(access.tenantId, async (trx) => {
    await postReceiptIn(trx, access, actor, id);
    return getReceiptIn(trx, access, id);
  });
}

export async function voidDraftReceipt(access: TenantAccess, actor: AuditActor, id: string) {
  return withTenant(access.tenantId, async (trx) => {
    const r = await trx.selectFrom('purchase_receipts').select(['status', 'number', 'version']).where('id', '=', id).forUpdate().executeTakeFirst();
    if (!r) throw Errors.notFound('purchase_receipt');
    if (r.status !== 'draft') throw Errors.conflict('receipt_not_draft', 'A posted receipt is corrected by a return to the supplier');
    await trx.updateTable('purchase_receipts').set({ status: 'void', version: r.version + 1 }).where('id', '=', id).execute();
    await audit(trx, actor, 'purchasing.receipt_voided', { tenantId: access.tenantId, targetType: 'purchase_receipt', targetId: id, data: { number: r.number } });
    return getReceiptIn(trx, access, id);
  });
}

// ── Supplier invoices ───────────────────────────────────────────────────────
async function linkIn(trx: Tx, tenantId: string, actorUserId: string | null, invoiceLineId: string, receiptLineId: string, quantity: number) {
  const il = await trx.selectFrom('supplier_invoice_lines as l').innerJoin('supplier_invoices as i', 'i.id', 'l.invoice_id')
    .select(['l.id', 'l.inventory_item_id', 'l.quantity', 'i.status', 'i.supplier_id']).where('l.id', '=', invoiceLineId).executeTakeFirst();
  if (!il) throw Errors.notFound('supplier_invoice_line');
  if (il.status !== 'draft') throw Errors.conflict('invoice_not_draft', 'Links are set while the invoice is a draft');
  const rl = await trx.selectFrom('purchase_receipt_lines as l').innerJoin('purchase_receipts as r', 'r.id', 'l.receipt_id')
    .select(['l.id', 'l.inventory_item_id', 'l.quantity', 'r.status', 'r.supplier_id']).where('l.id', '=', receiptLineId).forUpdate(['l']).executeTakeFirst();
  if (!rl) throw Errors.notFound('purchase_receipt_line');
  if (rl.status !== 'posted') throw Errors.invalid('receipt_not_posted', 'Only posted receipts can be matched');
  if (rl.inventory_item_id !== il.inventory_item_id) throw Errors.invalid('link_item_mismatch', 'The invoice line and the received line are different items');
  if (rl.supplier_id && rl.supplier_id !== il.supplier_id) throw Errors.invalid('link_supplier_mismatch', 'The receipt is from another supplier');
  const usedR = await trx.selectFrom('supplier_invoice_receipt_links as k').innerJoin('supplier_invoice_lines as l', 'l.id', 'k.invoice_line_id').innerJoin('supplier_invoices as i', 'i.id', 'l.invoice_id')
    .select(sql<number>`coalesce(sum(k.quantity), 0)`.as('q')).where('k.receipt_line_id', '=', receiptLineId).where('i.status', '<>', 'void').where('k.invoice_line_id', '<>', invoiceLineId).executeTakeFirstOrThrow();
  if (milli(Number(usedR.q)) + milli(quantity) > milli(Number(rl.quantity))) throw Errors.invalid('link_exceeds_received', 'More than was received on that line is already invoiced');
  const usedI = await trx.selectFrom('supplier_invoice_receipt_links').select(sql<number>`coalesce(sum(quantity), 0)`.as('q')).where('invoice_line_id', '=', invoiceLineId).where('receipt_line_id', '<>', receiptLineId).executeTakeFirstOrThrow();
  if (milli(Number(usedI.q)) + milli(quantity) > milli(Number(il.quantity))) throw Errors.invalid('link_exceeds_invoiced', 'More than the invoice line quantity');
  await trx.insertInto('supplier_invoice_receipt_links').values({ tenant_id: tenantId, invoice_line_id: invoiceLineId, receipt_line_id: receiptLineId, quantity, created_by: actorUserId })
    .onConflict((oc) => oc.columns(['invoice_line_id', 'receipt_line_id']).doUpdateSet({ quantity })).execute();
}

export async function getInvoiceIn(trx: Tx, id: string) {
  const inv = await trx.selectFrom('supplier_invoices as i').innerJoin('suppliers as s', 's.id', 'i.supplier_id').selectAll('i').select(['s.name as supplier_name']).where('i.id', '=', id).executeTakeFirst();
  if (!inv) throw Errors.notFound('supplier_invoice');
  const lines = await trx.selectFrom('supplier_invoice_lines as l').leftJoin('inventory_items as it', 'it.id', 'l.inventory_item_id')
    .select(['l.id', 'l.inventory_item_id', 'it.name as item_name', 'l.description', 'l.quantity', 'l.unit_cost_minor', 'l.discount_minor', 'l.tax_minor', 'l.net_minor',
      sql<number>`coalesce((select sum(k.quantity) from supplier_invoice_receipt_links k where k.invoice_line_id = l.id), 0)`.as('matched_qty')])
    .where('l.invoice_id', '=', id).orderBy('l.created_at').execute();
  const links = await trx.selectFrom('supplier_invoice_receipt_links as k').innerJoin('supplier_invoice_lines as l', 'l.id', 'k.invoice_line_id')
    .innerJoin('purchase_receipt_lines as rl', 'rl.id', 'k.receipt_line_id').innerJoin('purchase_receipts as r', 'r.id', 'rl.receipt_id')
    .select(['k.id', 'k.invoice_line_id', 'k.receipt_line_id', 'k.quantity', 'r.number as receipt_number', 'r.id as receipt_id']).where('l.invoice_id', '=', id).execute();
  const paid = await trx.selectFrom('supplier_payments').select(sql<number>`coalesce(sum(amount_minor), 0)::bigint`.as('v')).where('invoice_id', '=', id).executeTakeFirstOrThrow();
  const matchedAll = lines.filter((l) => l.inventory_item_id).every((l) => milli(Number(l.matched_qty)) >= milli(Number(l.quantity)));
  const anyMatched = lines.some((l) => Number(l.matched_qty) > 0);
  return {
    ...inv, paid_minor: paid.v, outstanding_minor: inv.status === 'posted' ? inv.total_minor - paid.v : 0,
    payment_status: inv.status !== 'posted' ? null : paid.v <= 0 ? 'unpaid' : paid.v < inv.total_minor ? 'partly_paid' : 'paid',
    matching: matchedAll ? 'matched' : anyMatched ? 'partly_matched' : 'unmatched',
    lines: lines.map((l) => ({ ...l, quantity: Number(l.quantity), unit_cost_minor: Number(l.unit_cost_minor), matched_qty: Number(l.matched_qty) })),
    links: links.map((k) => ({ ...k, quantity: Number(k.quantity) })),
  };
}

export async function getInvoice(access: TenantAccess, id: string) {
  return withTenant(access.tenantId, (trx) => getInvoiceIn(trx, id));
}

export async function listInvoices(access: TenantAccess, q: { status?: string; supplier_id?: string } = {}) {
  return withTenant(access.tenantId, async (trx) => {
    let s = trx.selectFrom('supplier_invoices').select('id');
    if (q.status) s = s.where('status', '=', q.status);
    if (q.supplier_id) s = s.where('supplier_id', '=', q.supplier_id);
    const ids = await s.orderBy('invoice_date', 'desc').orderBy('created_at', 'desc').limit(200).execute();
    const out = [];
    for (const r of ids) {
      const { lines: _l, links: _k, ...inv } = await getInvoiceIn(trx, r.id);
      out.push(inv);
    }
    return out;
  });
}

async function postInvoiceIn(trx: Tx, access: TenantAccess, actor: AuditActor, id: string) {
  const inv = await trx.selectFrom('supplier_invoices').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
  if (!inv) throw Errors.notFound('supplier_invoice');
  if (inv.status !== 'draft') throw Errors.conflict('invoice_not_draft', 'This invoice was already posted or voided');
  if (await alreadyPosted(trx, access.tenantId, 'supplier_invoice', id)) throw Errors.conflict('already_posted');
  const lines = await trx.selectFrom('supplier_invoice_lines').selectAll().where('invoice_id', '=', id).orderBy('created_at').execute();
  const j: Line[] = [];
  const add = (account: Line['account'], amount: number, memo?: string) => {
    if (!amount) return;
    j.push(amount > 0 ? { account, debit: amount, memo } : { account, credit: -amount, memo });
  };
  for (const l of lines) {
    const net = Number(l.net_minor);
    if (!l.inventory_item_id) { add('operating_expenses', net, l.description ?? 'non-stock line'); continue; }
    const links = await trx.selectFrom('supplier_invoice_receipt_links as k').innerJoin('purchase_receipt_lines as rl', 'rl.id', 'k.receipt_line_id')
      .leftJoin('stock_movements as m', 'm.id', 'rl.movement_id')
      .select(['k.quantity', 'rl.inventory_item_id', 'm.unit_cost_minor']).where('k.invoice_line_id', '=', l.id).execute();
    const lineQty = Number(l.quantity);
    let matchedQty = 0, matchedValue = 0;
    for (const k of links) { matchedQty += Number(k.quantity); matchedValue += Math.round(Number(k.quantity) * Number(k.unit_cost_minor ?? 0)); }
    const matchedNet = milli(matchedQty) >= milli(lineQty) ? net : Math.round((net * matchedQty) / lineQty);
    add('goods_received_not_invoiced', matchedValue, 'matched to receipts');
    // Not received yet: clears when the goods are received.
    add('goods_received_not_invoiced', net - matchedNet, 'invoiced before receipt');
    const variance = matchedNet - matchedValue;
    if (variance !== 0) {
      // Price difference: re-values stock still on hand; whatever was already used/sold goes to its cost account.
      const it = await trx.selectFrom('inventory_items').select(['id', 'kind', 'on_hand', 'stock_value_minor', 'avg_cost_minor']).where('id', '=', links[0]?.inventory_item_id ?? l.inventory_item_id).forUpdate().executeTakeFirstOrThrow();
      const onHand = Number(it.on_hand);
      let toStock = 0;
      if (onHand > 0 && matchedQty > 0) {
        toStock = Math.round((variance * Math.min(onHand, matchedQty)) / matchedQty);
        if (Number(it.stock_value_minor) + toStock < 0) toStock = -Number(it.stock_value_minor);
        const value = Number(it.stock_value_minor) + toStock;
        await trx.updateTable('inventory_items').set({ stock_value_minor: value, avg_cost_minor: Math.round((value / onHand) * 10000) / 10000 }).where('id', '=', it.id).execute();
      }
      add('inventory', toStock, 'invoice price difference');
      add(it.kind === 'material' ? 'material_costs' : 'cogs', variance - toStock, 'invoice price difference (already used)');
    }
  }
  const tax = lines.reduce((a, l) => a + Number(l.tax_minor), 0);
  add('input_tax', tax);
  const total = lines.reduce((a, l) => a + Number(l.net_minor) + Number(l.tax_minor), 0);
  j.push({ account: 'accounts_payable', credit: total });
  await post(trx, access.tenantId, { type: 'supplier_invoice', id }, j, { createdBy: actor.userId, occurredAt: new Date(`${inv.invoice_date}T12:00:00Z`), memo: inv.invoice_number });
  await trx.updateTable('supplier_invoices').set({ status: 'posted', posted_at: new Date(), posted_by: actor.userId, version: inv.version + 1 }).where('id', '=', id).execute();
  await audit(trx, actor, 'purchasing.invoice_posted', { tenantId: access.tenantId, targetType: 'supplier_invoice', targetId: id, data: { number: inv.invoice_number, total_minor: total } });
}

export async function createInvoice(access: TenantAccess, actor: AuditActor, input: z.infer<typeof invoiceInput>) {
  return withTenant(access.tenantId, async (trx) => {
    await requireSupplier(trx, input.supplier_id);
    const dup = await trx.selectFrom('supplier_invoices').select('id').where('supplier_id', '=', input.supplier_id)
      .where(sql<boolean>`lower(invoice_number) = lower(${input.invoice_number})`).executeTakeFirst();
    if (dup) throw Errors.conflict('duplicate_invoice_number', 'This supplier invoice number is already recorded', { id: dup.id });
    const ids = [...new Set(input.lines.map((l) => l.inventory_item_id).filter((x): x is string => !!x))];
    if (ids.length) {
      const found = await trx.selectFrom('inventory_items').select('id').where('id', 'in', ids).execute();
      if (found.length !== ids.length) throw Errors.notFound('inventory_item');
    }
    const lines = input.lines.map((l) => {
      const gross = Math.round(l.quantity * l.unit_cost_minor);
      if (l.discount_minor > gross) throw Errors.invalid('discount_exceeds_line');
      return { ...l, net: gross - l.discount_minor };
    });
    const subtotal = lines.reduce((a, l) => a + l.net + l.discount_minor, 0);
    const discount = lines.reduce((a, l) => a + l.discount_minor, 0);
    const tax = lines.reduce((a, l) => a + l.tax_minor, 0);
    const inv = await trx.insertInto('supplier_invoices').values({
      tenant_id: access.tenantId, supplier_id: input.supplier_id, invoice_number: input.invoice_number, invoice_date: input.invoice_date,
      due_date: input.due_date ?? null, attachment_asset_id: input.attachment_asset_id ?? null, note: input.note ?? null,
      subtotal_minor: subtotal, discount_minor: discount, tax_minor: tax, total_minor: subtotal - discount + tax, created_by: actor.userId,
    }).returning('id').executeTakeFirstOrThrow();
    for (const l of lines) {
      const row = await trx.insertInto('supplier_invoice_lines').values({
        tenant_id: access.tenantId, invoice_id: inv.id, inventory_item_id: l.inventory_item_id ?? null, description: l.description ?? null,
        quantity: l.quantity, unit_cost_minor: l.unit_cost_minor, discount_minor: l.discount_minor, tax_minor: l.tax_minor, net_minor: l.net,
      }).returning('id').executeTakeFirstOrThrow();
      if (l.links.length && !l.inventory_item_id) throw Errors.invalid('link_item_mismatch', 'Only stock lines can be matched to receipts');
      for (const k of l.links) await linkIn(trx, access.tenantId, actor.userId, row.id, k.receipt_line_id, k.quantity);
    }
    await audit(trx, actor, 'purchasing.invoice_created', { tenantId: access.tenantId, targetType: 'supplier_invoice', targetId: inv.id, data: { number: input.invoice_number } });
    if (input.post) await postInvoiceIn(trx, access, actor, inv.id);
    return getInvoiceIn(trx, inv.id);
  });
}

export async function linkInvoiceLine(access: TenantAccess, actor: AuditActor, invoiceId: string, input: z.infer<typeof invoiceLinkInput>) {
  return withTenant(access.tenantId, async (trx) => {
    const l = await trx.selectFrom('supplier_invoice_lines').select('invoice_id').where('id', '=', input.invoice_line_id).executeTakeFirst();
    if (!l || l.invoice_id !== invoiceId) throw Errors.notFound('supplier_invoice_line');
    await linkIn(trx, access.tenantId, actor.userId, input.invoice_line_id, input.receipt_line_id, input.quantity);
    await audit(trx, actor, 'purchasing.invoice_linked', { tenantId: access.tenantId, targetType: 'supplier_invoice', targetId: invoiceId, data: input });
    return getInvoiceIn(trx, invoiceId);
  });
}

export async function postInvoice(access: TenantAccess, actor: AuditActor, id: string) {
  return withTenant(access.tenantId, async (trx) => {
    await postInvoiceIn(trx, access, actor, id);
    return getInvoiceIn(trx, id);
  });
}

export async function voidDraftInvoice(access: TenantAccess, actor: AuditActor, id: string, reason: string) {
  return withTenant(access.tenantId, async (trx) => {
    const inv = await trx.selectFrom('supplier_invoices').select(['status', 'version']).where('id', '=', id).forUpdate().executeTakeFirst();
    if (!inv) throw Errors.notFound('supplier_invoice');
    if (inv.status !== 'draft') throw Errors.conflict('invoice_not_draft', 'A posted supplier invoice is corrected with the supplier (credit note), not voided here');
    await trx.updateTable('supplier_invoices').set({ status: 'void', voided_at: new Date(), voided_by: actor.userId, void_reason: reason, version: inv.version + 1 }).where('id', '=', id).execute();
    await audit(trx, actor, 'purchasing.invoice_voided', { tenantId: access.tenantId, targetType: 'supplier_invoice', targetId: id, data: { reason } });
    return getInvoiceIn(trx, id);
  });
}

// ── Payments ────────────────────────────────────────────────────────────────
export async function createPayment(access: TenantAccess, actor: AuditActor, input: z.infer<typeof paymentInput>, idempotencyKey: string | null) {
  return withTenant(access.tenantId, async (trx) => {
    const run = async () => {
      await requireSupplier(trx, input.supplier_id);
      if (input.invoice_id) {
        const inv = await trx.selectFrom('supplier_invoices').select(['id', 'status', 'supplier_id', 'total_minor']).where('id', '=', input.invoice_id).forUpdate().executeTakeFirst();
        if (!inv) throw Errors.notFound('supplier_invoice');
        if (inv.supplier_id !== input.supplier_id) throw Errors.invalid('invoice_other_supplier');
        if (inv.status !== 'posted') throw Errors.invalid('invoice_not_posted', 'Post the invoice before paying it');
        const paid = await trx.selectFrom('supplier_payments').select(sql<number>`coalesce(sum(amount_minor), 0)::bigint`.as('v')).where('invoice_id', '=', inv.id).executeTakeFirstOrThrow();
        if (paid.v + input.amount_minor > inv.total_minor) throw Errors.invalid('overpayment', 'More than the invoice outstanding', { outstanding_minor: inv.total_minor - paid.v });
      }
      const p = await trx.insertInto('supplier_payments').values({
        tenant_id: access.tenantId, supplier_id: input.supplier_id, invoice_id: input.invoice_id ?? null, amount_minor: input.amount_minor,
        method: input.method, paid_on: input.paid_on, reference: input.reference ?? null, note: input.note ?? null, created_by: actor.userId,
      }).returningAll().executeTakeFirstOrThrow();
      await post(trx, access.tenantId, { type: 'supplier_payment', id: p.id }, [
        { account: 'accounts_payable', debit: p.amount_minor }, { account: input.method === 'bank' ? 'bank' : 'cash_on_hand', credit: p.amount_minor },
      ], { createdBy: actor.userId, occurredAt: new Date(`${input.paid_on}T12:00:00Z`), memo: input.reference ?? 'supplier payment' });
      await audit(trx, actor, 'purchasing.payment_recorded', { tenantId: access.tenantId, targetType: 'supplier_payment', targetId: p.id, data: { amount_minor: p.amount_minor, method: p.method } });
      return { status: 201, body: p };
    };
    if (!idempotencyKey) return (await run()).body;
    return (await idempotent(trx, { scope: `tenant:${access.tenantId}`, operation: 'purchasing.payment', key: idempotencyKey, hash: requestHash(input) }, run)).body;
  });
}

export async function listPayments(access: TenantAccess) {
  return withTenant(access.tenantId, (trx) => trx.selectFrom('supplier_payments as p').innerJoin('suppliers as s', 's.id', 'p.supplier_id')
    .leftJoin('supplier_invoices as i', 'i.id', 'p.invoice_id')
    .select(['p.id', 'p.supplier_id', 's.name as supplier_name', 'p.invoice_id', 'i.invoice_number', 'p.amount_minor', 'p.method', 'p.paid_on', 'p.reference', 'p.created_at'])
    .orderBy('p.paid_on', 'desc').limit(200).execute());
}

// ── Return to supplier ──────────────────────────────────────────────────────
export async function returnToSupplier(access: TenantAccess, actor: AuditActor, input: z.infer<typeof supplierReturnInput>) {
  return withTenant(access.tenantId, async (trx) => {
    await requireSupplier(trx, input.supplier_id);
    const docId = randomUUID();
    const out = [];
    for (const l of [...input.lines].sort((a, b) => a.inventory_item_id.localeCompare(b.inventory_item_id))) {
      let counter: 'accounts_payable' | 'goods_received_not_invoiced' = 'goods_received_not_invoiced';
      let locationId = input.location_id ?? null;
      if (l.receipt_line_id) {
        const rl = await trx.selectFrom('purchase_receipt_lines as rl').innerJoin('purchase_receipts as r', 'r.id', 'rl.receipt_id')
          .select(['rl.inventory_item_id', 'r.location_id', 'r.supplier_id', sql<number>`coalesce((select sum(k.quantity) from supplier_invoice_receipt_links k join supplier_invoice_lines il on il.id = k.invoice_line_id join supplier_invoices iv on iv.id = il.invoice_id where k.receipt_line_id = rl.id and iv.status = 'posted'), 0)`.as('invoiced')])
          .where('rl.id', '=', l.receipt_line_id).executeTakeFirst();
        if (!rl || rl.inventory_item_id !== l.inventory_item_id) throw Errors.notFound('purchase_receipt_line');
        if (rl.supplier_id && rl.supplier_id !== input.supplier_id) throw Errors.invalid('link_supplier_mismatch');
        if (Number(rl.invoiced) > 0) counter = 'accounts_payable';
        locationId = locationId ?? rl.location_id;
      }
      const r = await moveStock(trx, access.tenantId, l.inventory_item_id, {
        kind: 'return_to_supplier', quantity: -l.quantity, dOnHand: -l.quantity, dReserved: 0, reason: input.reason, actorUserId: actor.userId,
        locationId, refType: 'supplier_return', refId: docId, documentType: 'supplier_return', documentId: docId, journalCounter: counter,
      });
      if (!r) throw Errors.conflict('insufficient_stock', 'The location does not hold that quantity', { inventory_item_id: l.inventory_item_id });
      out.push({ inventory_item_id: l.inventory_item_id, quantity: l.quantity, movement_id: r.movementId, cost_minor: r.totalCostMinor == null ? null : -r.totalCostMinor, settled_against: counter });
    }
    await audit(trx, actor, 'purchasing.returned_to_supplier', { tenantId: access.tenantId, targetType: 'supplier', targetId: input.supplier_id, data: { document_id: docId, lines: out.length, reason: input.reason } });
    return { document_id: docId, lines: out };
  });
}
