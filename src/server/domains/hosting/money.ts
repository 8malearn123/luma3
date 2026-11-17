import { sql } from 'kysely';
import type { Tx } from '../../db/client';
import { nextReadableNumber } from '../../infra/counters';
import { moveStock } from '../commerce/stock';
import { sellerSnapshot } from '../finance/service';
import { post, type Line } from '../finance/journal';
import { taxOf, type TaxRule } from '@/shared/schemas/hosting';

/**
 * Money for workspace bookings: frozen lines, journal postings for BOTH
 * parties, the automatic invoice host → guest business (D13), the settlement
 * statement and the single stock helper for product add-ons (D5).
 * All functions expect a system-scoped transaction (see scope.ts).
 *
 * Only rent, equipment, approved late fees, add-on products and corrections are
 * ever posted. The expert's client service revenue never appears here (D3).
 */
type W = { id: string; number: string; host_tenant_id: string; guest_tenant_id: string; branch_id: string; currency: string };
export type LineRow = Awaited<ReturnType<typeof bookingLines>>[number];

export async function bookingLines(trx: Tx, wbId: string) {
  return trx.selectFrom('workspace_booking_lines').selectAll().where('workspace_booking_id', '=', wbId).orderBy('created_at').orderBy('id').execute();
}

export async function taxRuleFor(trx: Tx, hostTenantId: string): Promise<TaxRule & { label: string | null }> {
  const s = await trx.selectFrom('tenant_settings').select(['tax_rate_bp', 'prices_include_tax', 'tax_label']).where('tenant_id', '=', hostTenantId).executeTakeFirstOrThrow();
  return { rate_bp: s.tax_rate_bp, prices_include_tax: s.prices_include_tax, label: s.tax_label };
}

// ── Stock (D5): the ONLY place hosting touches salon stock ───────────────────
/**
 * Sells whole products from the salon store to the expert (a normal sale
 * movement from the branch's default location, exactly once per line via the
 * movement's unique ref). The movement freezes the weighted-average cost and
 * posts the cost of goods; this module only posts the revenue side. The
 * expert's own materials never pass through here.
 */
export async function sellAddonStock(trx: Tx, hostTenantId: string, line: { id: string; product_variant_id: string; quantity: number; branch_id: string }, actorUserId: string | null) {
  const item = await trx.selectFrom('inventory_items as i').leftJoin('product_variants as v', 'v.id', 'i.variant_id')
    .select(['i.id']).where('i.tenant_id', '=', hostTenantId).where('i.variant_id', '=', line.product_variant_id).where('i.branch_id', '=', line.branch_id)
    .executeTakeFirst();
  if (!item) return null;
  const moved = await moveStock(trx, hostTenantId, item.id, {
    kind: 'sale', quantity: -line.quantity, dOnHand: -line.quantity, dReserved: 0, refType: 'workspace_booking_line', refId: line.id, actorUserId,
  });
  if (!moved) return null;
  // Weighted-average cost frozen on the movement (D15). moveStock itself posts Dr cogs / Cr inventory.
  return { itemId: item.id, unitCostMinor: moved.unitCostMinor ?? null };
}

/** Puts back a product that was never handed over (cancellation / no-show). */
export async function returnAddonStock(trx: Tx, hostTenantId: string, line: { id: string; inventory_item_id: string; quantity: number }, actorUserId: string | null) {
  await moveStock(trx, hostTenantId, line.inventory_item_id, {
    kind: 'return', quantity: line.quantity, dOnHand: line.quantity, dReserved: 0, refType: 'workspace_booking_line', refId: line.id, actorUserId,
  });
}

/** Available units of a variant at the listing's branch (advisory, at request time). */
export async function availableUnits(trx: Tx, hostTenantId: string, variantId: string, branchId: string) {
  const i = await trx.selectFrom('inventory_items').select([sql<number>`(on_hand - reserved)`.as('a')]).where('tenant_id', '=', hostTenantId).where('variant_id', '=', variantId).where('branch_id', '=', branchId).executeTakeFirst();
  return i ? Number(i.a) : 0;
}

// ── Journal ─────────────────────────────────────────────────────────────────
type Moneyish = { kind: string; status: string; amount_minor: number; tax_included: boolean };

/** Totals of a group of lines (approved only): what the guest owes and how the host recognises it. */
export function splitLines(lines: Moneyish[]) {
  const ok = lines.filter((l) => l.status === 'approved');
  const sum = (kinds: string[]) => ok.filter((l) => kinds.includes(l.kind)).reduce((a, l) => a + l.amount_minor, 0);
  const hosting = sum(['rent', 'equipment', 'late_fee', 'correction']);
  const product = sum(['product']);
  const discount = -sum(['discount']);
  const taxLines = ok.filter((l) => l.kind === 'tax');
  const tax = taxLines.reduce((a, l) => a + l.amount_minor, 0);
  const included = taxLines.some((l) => l.tax_included);
  let hostingNet = hosting, productNet = product;
  if (included && tax > 0) {
    // Tax-inclusive prices: the tax was computed ONCE on the booking base (after
    // the add-ons discount, half-up to the halala — see quote/taxOf) and is taken
    // out of each revenue stream in proportion to what that stream actually
    // charges. The add-ons discount (D5b) reduces the add-on streams only
    // (products and equipment), never the rent, so it is allocated to products
    // and equipment by their amounts before the split (LUMA-AUDIT-037: splitting
    // by the pre-discount gross under-taxed the rent, e.g. 8713 instead of 8696).
    const equipment = sum(['equipment']);
    const addons = product + equipment;
    const dP = addons > 0 ? Math.round((discount * product) / addons) : 0;
    const productBase = product - dP;
    const hostingBase = hosting - (discount - dP);
    const base = productBase + hostingBase;
    const tP = base > 0 ? Math.round((tax * productBase) / base) : 0;
    productNet -= tP; hostingNet -= tax - tP;
  }
  return { hosting, product, discount, tax, included, hostingNet, productNet, total: hosting + product - discount + (included ? 0 : tax) };
}

function revenueCredits(s: ReturnType<typeof splitLines>): Line[] {
  return [
    { account: 'discounts', debit: s.discount },
    { account: 'hosting_revenue', credit: s.hostingNet }, { account: 'product_revenue', credit: s.productNet }, { account: 'tax_payable', credit: s.tax },
  ];
}

/** Payment captured for the booking's own lines: host earns, guest records the expense. */
export async function postBookingPaid(trx: Tx, w: W, paymentId: string, lines: Moneyish[], actorUserId: string | null) {
  const s = splitLines(lines);
  await post(trx, w.host_tenant_id, { type: 'workspace_payment', id: paymentId }, [{ account: 'provider_clearing', debit: s.total }, ...revenueCredits(s)],
    { createdBy: actorUserId, memo: `space booking ${w.number}` });
  await post(trx, w.guest_tenant_id, { type: 'workspace_payment', id: paymentId }, [{ account: 'hosting_expense', debit: s.total }, { account: 'bank', credit: s.total }],
    { createdBy: actorUserId, memo: `space rent ${w.number}` });
  return s.total;
}

/** An extra charge approved after payment (late fee, material request, correction): receivable / payable until paid. */
export async function postExtraCharge(trx: Tx, w: W, refId: string, lines: Moneyish[], actorUserId: string | null) {
  const s = splitLines(lines);
  if (s.total <= 0) return 0;
  await post(trx, w.host_tenant_id, { type: 'workspace_charge', id: refId }, [{ account: 'hosting_receivable', debit: s.total }, ...revenueCredits(s)],
    { createdBy: actorUserId, memo: `space booking ${w.number}` });
  await post(trx, w.guest_tenant_id, { type: 'workspace_charge', id: refId }, [{ account: 'hosting_expense', debit: s.total }, { account: 'hosting_payable', credit: s.total }],
    { createdBy: actorUserId, memo: `space booking ${w.number}` });
  return s.total;
}

export async function postExtraPaid(trx: Tx, w: W, paymentId: string, amount: number) {
  await post(trx, w.host_tenant_id, { type: 'workspace_payment', id: paymentId }, [{ account: 'provider_clearing', debit: amount }, { account: 'hosting_receivable', credit: amount }], { memo: `space dues ${w.number}` });
  await post(trx, w.guest_tenant_id, { type: 'workspace_payment', id: paymentId }, [{ account: 'hosting_payable', debit: amount }, { account: 'bank', credit: amount }], { memo: `space dues ${w.number}` });
}

/**
 * A refund to the expert. The amount is tax-inclusive money; the host takes the
 * tax share out of tax_payable at the booking's frozen rate (the same rule that
 * charged it), so a full refund leaves no revenue and no tax behind
 * (LUMA-AUDIT-037). The expert's side reverses her expense in full: her input
 * tax is carried inside the expense (requirement 17).
 */
export async function postRefund(trx: Tx, w: W, refundId: string, amount: number, tax?: TaxRule | null) {
  const taxPart = tax && tax.rate_bp > 0 ? Math.round((amount * tax.rate_bp) / (10000 + tax.rate_bp)) : 0;
  await post(trx, w.host_tenant_id, { type: 'workspace_refund', id: refundId },
    [{ account: 'refunds', debit: amount - taxPart }, { account: 'tax_payable', debit: taxPart }, { account: 'provider_clearing', credit: amount }], { memo: `space refund ${w.number}` });
  await post(trx, w.guest_tenant_id, { type: 'workspace_refund', id: refundId }, [{ account: 'bank', debit: amount }, { account: 'hosting_expense', credit: amount }], { memo: `space refund ${w.number}` });
}

// ── Invoice (D13) ───────────────────────────────────────────────────────────
/**
 * Automatic invoice from the host salon to the expert's business for the lines
 * a payment covered. It is a simplified tax invoice when the salon has a VAT
 * number (the invoice renderer adds the phase-1 QR from the seller snapshot).
 */
export async function issueWorkspaceInvoice(trx: Tx, w: W, paymentId: string, lines: LineRow[]) {
  const existing = await trx.selectFrom('invoices').select('id').where('tenant_id', '=', w.host_tenant_id).where('payment_id', '=', paymentId).where('kind', '=', 'invoice').executeTakeFirst();
  if (existing) return existing.id;
  const buyer = await trx.selectFrom('tenants as t').innerJoin('tenant_settings as s', 's.tenant_id', 't.id')
    .select(['t.name', 's.legal_name', 's.tax_number', 's.legal_address']).where('t.id', '=', w.guest_tenant_id).executeTakeFirstOrThrow();
  const s = splitLines(lines);
  const number = await nextReadableNumber(trx, w.host_tenant_id, 'invoice');
  const inv = await trx.insertInto('invoices').values({
    tenant_id: w.host_tenant_id, number, kind: 'invoice', payment_id: paymentId, workspace_booking_id: w.id, buyer_tenant_id: w.guest_tenant_id,
    seller_snapshot: JSON.stringify(await sellerSnapshot(trx, w.host_tenant_id)),
    buyer_snapshot: JSON.stringify({ name: buyer.legal_name || buyer.name, business_name: buyer.name, tax_number: buyer.tax_number, address: buyer.legal_address, kind: 'business' }),
    subtotal_minor: s.hosting + s.product, discount_minor: s.discount, tax_minor: s.tax, total_minor: s.total, currency: w.currency,
    tax_basis: JSON.stringify({ prices_include_tax: s.included, source: 'workspace_booking', booking_number: w.number }),
  }).returning('id').executeTakeFirstOrThrow();
  const items = lines.filter((l) => l.status === 'approved' && !['tax', 'discount'].includes(l.kind));
  if (items.length) {
    await trx.insertInto('invoice_items').values(items.map((l) => ({
      tenant_id: w.host_tenant_id, invoice_id: inv.id, description: l.description, quantity: l.quantity, unit_price_minor: l.unit_price_minor, line_total_minor: l.amount_minor,
    }))).execute();
  }
  await trx.updateTable('workspace_booking_lines').set({ invoice_id: inv.id }).where('id', 'in', lines.map((l) => l.id)).execute();
  return inv.id;
}

// ── Settlement statement ────────────────────────────────────────────────────
export async function platformFeeSetting(trx: Tx) {
  const rows = await trx.selectFrom('platform_settings').select(['key', 'value']).where('key', 'in', ['hosting_platform_fee_enabled', 'hosting_platform_fee_bp']).execute();
  const get = (k: string) => rows.find((r) => r.key === k)?.value;
  // D11: the structure exists; value 0 and disabled unless the platform enables it.
  return { enabled: get('hosting_platform_fee_enabled') === true, bp: Number(get('hosting_platform_fee_bp') ?? 0) || 0 };
}

/**
 * Per-booking statement, the same numbers for both parties: rent, salon
 * percentage (0 — disabled, D2), add-ons, discounts, approved late fees,
 * corrections, tax, collected, refunded, due, platform fee (0 — disabled, D11).
 */
export async function statement(trx: Tx, w: { id: string; currency: string; paid_minor: number; refunded_minor: number; settlement_status: string; status: string }) {
  const lines = await bookingLines(trx, w.id);
  const ok = lines.filter((l) => l.status === 'approved');
  const sum = (k: string) => ok.filter((l) => l.kind === k).reduce((a, l) => a + l.amount_minor, 0);
  const s = splitLines(lines);
  const fee = await platformFeeSetting(trx);
  const collected = w.paid_minor - w.refunded_minor;
  // LUMA-AUDIT-037: the salon's net is what this booking earns it (total charges
  // under the saved terms, less the platform fee — 0 and disabled, D11), not the
  // cash collected so far; collected/due/credit are shown separately.
  const platformFee = fee.enabled ? Math.round((s.total * fee.bp) / 10000) : 0;
  const taxExtra = s.included ? 0 : s.tax;
  return {
    currency: w.currency, booking_status: w.status, settlement_status: w.settlement_status,
    rent_minor: sum('rent'),
    salon_percentage: { enabled: false, amount_minor: 0 },
    products_minor: sum('product'), equipment_minor: sum('equipment'), discounts_minor: -sum('discount'),
    late_fees_minor: sum('late_fee'),
    late_fees_proposed_minor: lines.filter((l) => l.kind === 'late_fee' && l.status === 'proposed').reduce((a, l) => a + l.amount_minor, 0),
    corrections_minor: sum('correction'),
    tax_minor: s.tax, tax_included: s.included,
    total_charges_minor: s.total,
    collected_minor: w.paid_minor, refunded_minor: w.refunded_minor,
    due_from_guest_minor: Math.max(0, s.total - collected),
    credit_to_guest_minor: Math.max(0, collected - s.total),
    platform_fee: { enabled: fee.enabled, bp: fee.enabled ? fee.bp : 0, amount_minor: platformFee },
    host_net_minor: s.total - platformFee,
    collected_net_minor: collected,
    tax_extra_minor: taxExtra,
    lines: lines.map((l) => ({ id: l.id, kind: l.kind, status: l.status, charge_group: l.charge_group, description: l.description, quantity: l.quantity, unit_price_minor: l.unit_price_minor, amount_minor: l.amount_minor, tax_included: l.tax_included, paid: !!l.payment_id, invoice_id: l.invoice_id })),
  };
}

/** Lines for an extra charge (amount + its tax line under the host's rule). */
export function extraWithTax(amount: number, rule: TaxRule) {
  const t = taxOf(amount, rule);
  return { tax: t.tax, total: t.total };
}
