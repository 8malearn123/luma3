import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import { sql } from 'kysely';
import { z } from 'zod';
import { withTenant, type Tx } from '../../db/client';
import { Errors } from '../../http/errors';
import { audit, type AuditActor } from '../../infra/audit';
import { nextReadableNumber } from '../../infra/counters';
import { storage } from '../../infra/storage';
import { featureEnabled, type TenantAccess } from '../../tenancy/access';
import { inventoryValuation } from '../commerce';
import { post } from './journal';

// ── Expenses (void with reason; never deleted) ──────────────────────────────
export const expenseInput = z.object({
  branch_id: z.string().uuid().nullable().optional(),
  category: z.enum(['rent', 'salaries', 'supplies', 'marketing', 'utilities', 'equipment', 'fees', 'other']),
  amount_minor: z.number().int().positive().max(1_000_000_000),
  incurred_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  description: z.string().trim().max(500).optional(),
  receipt_asset_id: z.string().uuid().nullable().optional(),
}).strict();

export async function recordExpense(access: TenantAccess, actor: AuditActor, input: z.infer<typeof expenseInput>) {
  return withTenant(access.tenantId, async (trx) => {
    const e = await trx.insertInto('expenses').values({
      tenant_id: access.tenantId, branch_id: input.branch_id ?? null, category: input.category, amount_minor: input.amount_minor, incurred_on: input.incurred_on,
      description: input.description ?? null, receipt_asset_id: input.receipt_asset_id ?? null, recorded_by: actor.userId,
    }).returningAll().executeTakeFirstOrThrow();
    await post(trx, access.tenantId, { type: 'expense', id: e.id }, [{ account: 'operating_expenses', debit: e.amount_minor }, { account: 'cash_on_hand', credit: e.amount_minor }],
      { createdBy: actor.userId, occurredAt: new Date(`${input.incurred_on}T12:00:00Z`), memo: input.category });
    await audit(trx, actor, 'finance.expense_recorded', { tenantId: access.tenantId, targetType: 'expense', targetId: e.id, data: { amount_minor: e.amount_minor, category: e.category } });
    return e;
  });
}

/** Voiding posts an offsetting journal group; the original stays in history. */
export async function voidExpense(access: TenantAccess, actor: AuditActor, id: string, reason: string) {
  return withTenant(access.tenantId, async (trx) => {
    const e = await trx.selectFrom('expenses').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
    if (!e) throw Errors.notFound('expense');
    if (e.voided_at) throw Errors.conflict('already_void');
    await trx.updateTable('expenses').set({ voided_at: new Date(), voided_by: actor.userId, void_reason: reason }).where('id', '=', id).execute();
    const orig = await trx.selectFrom('financial_entries').select('entry_group_id').where('ref_type', '=', 'expense').where('ref_id', '=', id).executeTakeFirst();
    await post(trx, access.tenantId, { type: 'expense_void', id }, [{ account: 'cash_on_hand', debit: e.amount_minor }, { account: 'operating_expenses', credit: e.amount_minor }],
      { createdBy: actor.userId, reversesGroupId: orig?.entry_group_id ?? null, memo: reason });
    await audit(trx, actor, 'finance.expense_voided', { tenantId: access.tenantId, targetType: 'expense', targetId: id, data: { reason } });
    return { id, voided: true };
  });
}

export async function listExpenses(access: TenantAccess, from: string, to: string) {
  return withTenant(access.tenantId, (trx) => trx.selectFrom('expenses').selectAll().where('incurred_on', '>=', from).where('incurred_on', '<=', to).orderBy('incurred_on', 'desc').limit(500).execute());
}

// ── Reports ─────────────────────────────────────────────────────────────────
/**
 * Period report (business timezone). Each figure states its accounting basis.
 * Profit is shown only when every cost input is known; otherwise the report
 * says "costs incomplete" and lists what is missing.
 */
export async function financeReport(access: TenantAccess, fromISO: string, toISO: string) {
  const tz = access.timezone;
  const from = DateTime.fromISO(fromISO, { zone: tz }).startOf('day').toJSDate();
  const to = DateTime.fromISO(toISO, { zone: tz }).endOf('day').toJSDate();
  return withTenant(access.tenantId, async (trx) => {
    const acct = async (account: string) => {
      const r = await trx.selectFrom('financial_entries').select([sql<number>`coalesce(sum(credit_minor - debit_minor), 0)::bigint`.as('net')])
        .where('account', '=', account as never).where('occurred_at', '>=', from).where('occurred_at', '<=', to).executeTakeFirstOrThrow();
      return r.net;
    };
    const balance = async (account: string, sign: 1 | -1) => {
      const r = await trx.selectFrom('financial_entries').select([sql<number>`coalesce(sum(credit_minor - debit_minor), 0)::bigint`.as('net')])
        .where('account', '=', account as never).where('occurred_at', '<=', to).executeTakeFirstOrThrow();
      return sign * r.net;
    };
    const bookingValue = await trx.selectFrom('bookings').select([sql<number>`coalesce(sum(total_minor),0)::bigint`.as('v'), sql<number>`count(*)::int`.as('n')])
      .where('status', 'in', ['confirmed', 'checked_in', 'in_service', 'completed']).where('starts_at', '>=', from).where('starts_at', '<=', to).executeTakeFirstOrThrow();
    const collections = await trx.selectFrom('payments').select(['method', sql<number>`coalesce(sum(amount_minor),0)::bigint`.as('v')])
      .where('status', '=', 'captured').where('captured_at', '>=', from).where('captured_at', '<=', to).groupBy('method').execute();
    const refundsDone = await trx.selectFrom('refunds').select([sql<number>`coalesce(sum(amount_minor),0)::bigint`.as('v')]).where('status', '=', 'succeeded').where('completed_at', '>=', from).where('completed_at', '<=', to).executeTakeFirstOrThrow();
    const refundsPending = await trx.selectFrom('refunds').select([sql<number>`coalesce(sum(amount_minor),0)::bigint`.as('v')]).where('status', 'in', ['requested', 'pending']).executeTakeFirstOrThrow();
    const discounts = await trx.selectFrom('bookings').select([sql<number>`coalesce(sum(discount_minor),0)::bigint`.as('v')]).where('status', '=', 'completed').where('starts_at', '>=', from).where('starts_at', '<=', to).executeTakeFirstOrThrow();
    const orderDiscounts = await trx.selectFrom('orders').select([sql<number>`coalesce(sum(discount_minor),0)::bigint`.as('v')]).where('status', 'in', ['paid', 'preparing', 'ready', 'collected']).where('created_at', '>=', from).where('created_at', '<=', to).executeTakeFirstOrThrow();
    const expenses = await trx.selectFrom('expenses').select(['category', sql<number>`coalesce(sum(amount_minor),0)::bigint`.as('v')]).where('voided_at', 'is', null)
      .where('incurred_on', '>=', fromISO).where('incurred_on', '<=', toISO).groupBy('category').execute();
    // Commission expense: posted when a payroll month closes (and, for history, by the retired per-booking engine).
    const commissions = { v: -(await acct('commissions_expense')) };
    // Product and material costs: the cost frozen on each stock movement (weighted average at
    // that moment, D15), never quantity × today's cost. Sales net of goods returned to stock.
    const movCost = (kinds: string[]) => trx.selectFrom('stock_movements as m')
      .select([sql<number>`coalesce(sum(-m.total_cost_minor), 0)::bigint`.as('v'), sql<number>`count(*) filter (where m.unit_cost_minor is null and m.quantity < 0)::int`.as('missing')])
      .where('m.kind', 'in', kinds as never[]).where('m.created_at', '>=', from).where('m.created_at', '<=', to).executeTakeFirstOrThrow();
    const cogs = await movCost(['sale', 'return']);
    const materials = await movCost(['consumption', 'return_from_use']);
    const servicesWithoutCost = await trx.selectFrom('services').select(sql<number>`count(*)::int`.as('n')).where('archived_at', 'is', null).where('cost_minor', 'is', null).executeTakeFirstOrThrow();

    // Daily cash-basis series (business timezone) for charts; the totals above stay authoritative.
    const dailyCollections = await trx.selectFrom('payments')
      .select([sql<string>`to_char(captured_at at time zone ${tz}, 'YYYY-MM-DD')`.as('day'), sql<number>`coalesce(sum(amount_minor),0)::bigint`.as('v')])
      .where('status', '=', 'captured').where('captured_at', '>=', from).where('captured_at', '<=', to).groupBy(sql`1`).execute();
    const dailyExpenses = await trx.selectFrom('expenses')
      .select([sql<string>`to_char(incurred_on, 'YYYY-MM-DD')`.as('day'), sql<number>`coalesce(sum(amount_minor),0)::bigint`.as('v')])
      .where('voided_at', 'is', null).where('incurred_on', '>=', fromISO).where('incurred_on', '<=', toISO).groupBy(sql`1`).execute();
    const daily: Array<{ date: string; collections_minor: number; expenses_minor: number }> = [];
    const days = Math.min(400, Math.round(DateTime.fromISO(toISO).diff(DateTime.fromISO(fromISO), 'days').days) + 1);
    for (let i = 0; i < days; i++) {
      const date = DateTime.fromISO(fromISO).plus({ days: i }).toISODate()!;
      daily.push({ date, collections_minor: Number(dailyCollections.find((r) => r.day === date)?.v ?? 0), expenses_minor: Number(dailyExpenses.find((r) => r.day === date)?.v ?? 0) });
    }

    // Workspace hosting (LUMA-AUDIT-010). Same ledger, same accrual basis as the rest of the report:
    // the salon recognises hosting revenue when the space booking is paid or an extra charge is
    // approved (net of tax); the expert records her hosting expense at the same moments. The cash
    // collected for a space booking is a COLLECTION (cash basis, below) — never a second revenue event.
    const wsAcct = async (account: string) => {
      const r = await trx.selectFrom('financial_entries').select([sql<number>`coalesce(sum(credit_minor - debit_minor), 0)::bigint`.as('net')])
        .where('account', '=', account as never).where('ref_type', 'like', 'workspace\\_%').where('occurred_at', '>=', from).where('occurred_at', '<=', to).executeTakeFirstOrThrow();
      return Number(r.net);
    };
    const hostingRevenue = Number(await acct('hosting_revenue'));
    const hostingProducts = await wsAcct('product_revenue');
    const hostingDiscounts = 0 - (await wsAcct('discounts'));
    const hostingRefunds = 0 - (await wsAcct('refunds'));
    const hostingExpense = 0 - Number(await acct('hosting_expense'));
    const hostingNetRevenue = hostingRevenue - hostingDiscounts - hostingRefunds;

    const serviceRevenue = await acct('service_revenue');
    const productRevenue = await acct('product_revenue');
    const expenseTotal = expenses.reduce((a, e) => a + e.v, 0);
    // Closed payroll months: base salaries + bonuses − deductions (tips pass through to staff).
    const salaries = -(await acct('salaries_expense'));
    const inventoryLink = featureEnabled(access, 'feature.inventory_finance_link') ? await inventoryValuation(trx) : null;
    const missing: string[] = [];
    if (cogs.missing > 0) missing.push('product_unit_costs');
    if (materials.missing > 0) missing.push('material_unit_costs');
    if (servicesWithoutCost.n > 0 && materials.v === 0) missing.push('service_costs_or_recipes');
    const profit = missing.length ? null
      : Number(serviceRevenue) + Number(productRevenue) + hostingNetRevenue - Number(expenseTotal) - hostingExpense - Number(cogs.v) - Math.round(materials.v) - Number(commissions.v) - salaries;
    return {
      period: { from: fromISO, to: toISO, timezone: tz },
      booking_value: { amount_minor: bookingValue.v, count: bookingValue.n, basis: 'Total of confirmed/attended/completed bookings starting in the period (not revenue).' },
      completed_service_sales: { amount_minor: serviceRevenue, basis: 'Service revenue recognised at completion (net of tax), plus fees retained under booking policy, delivered membership sessions and expired gift-card balances.' },
      product_sales: { amount_minor: productRevenue, basis: 'Product revenue recognised when an order is paid, and whole products sold to hosted experts as space add-ons when the space booking is paid (net of tax).' },
      hosting_revenue: {
        amount_minor: hostingRevenue, product_addons_minor: hostingProducts, discounts_minor: hostingDiscounts, refunds_minor: hostingRefunds, net_minor: hostingNetRevenue,
        basis: 'Salon hosting: rent, equipment rental, approved late fees and corrections from space bookings, recognised when the booking is paid or an extra charge is approved (accrual, net of tax; journal account hosting_revenue). Less the add-ons discount and refunds to experts (net of the tax reversed). Product add-ons are inside product sales and are shown here for reference only. The expert\'s client services are never the salon\'s revenue. The cash received is counted under collections, not again as revenue.',
      },
      hosting_expense: {
        amount_minor: hostingExpense, dues_minor: await balance('hosting_payable', 1),
        basis: 'Expert hosting: rent, add-ons, approved fees and corrections paid or owed to host salons for space bookings, less refunds (accrual; journal account hosting_expense; tax included as invoiced by the salon). Unpaid dues are included and also shown separately.',
      },
      collections: { by_method: collections, total_minor: collections.reduce((a, c) => a + c.v, 0), basis: 'Money captured in the period (cash basis), including deposits.' },
      deposits_outstanding: { amount_minor: await balance('customer_deposits', 1), basis: 'Customer prepayments for services not yet delivered (a liability, not revenue).' },
      receivables: { amount_minor: await balance('accounts_receivable', -1), basis: 'Completed services not yet fully paid.' },
      refunds: { completed_minor: refundsDone.v, pending_minor: refundsPending.v, basis: 'Completed = provider/cashier confirmed. Pending refunds are not refunded yet.' },
      discounts: { amount_minor: discounts.v + orderDiscounts.v },
      provider_fees: { amount_minor: null, basis: 'Not reported by the sandbox provider; reconciled from settlements when a real provider is connected.' },
      expenses: { by_category: expenses, total_minor: expenseTotal },
      product_costs: { amount_minor: cogs.v, complete: cogs.missing === 0, missing_lines: cogs.missing, basis: 'Cost frozen on each sale movement (weighted average at the time).' },
      material_costs: { amount_minor: Math.round(materials.v), complete: materials.missing === 0, basis: 'Cost frozen on each consumption movement (weighted average at the time).' },
      commissions: { amount_minor: commissions.v },
      salaries: { amount_minor: salaries, basis: 'Base salaries and bonuses minus deductions from closed payroll months. Tips are paid through to staff and are not an expense.' },
      profit: profit === null
        ? { status: 'costs_incomplete', missing, amount_minor: null }
        : { status: 'computed', amount_minor: profit, formula: 'service sales + product sales + net hosting revenue − expenses − hosting expense − product costs − material costs − commissions − salaries' },
      inventory: inventoryLink ? {
        value_minor: inventoryLink.inventory_value_minor, ledger_minor: inventoryLink.ledger_inventory_minor,
        accounts_payable_minor: inventoryLink.accounts_payable_minor, received_not_invoiced_minor: inventoryLink.received_not_invoiced_minor,
        shrinkage_minor: inventoryLink.shrinkage_minor, items_without_cost: inventoryLink.items_without_cost, basis: inventoryLink.basis,
      } : null,
      tax: {
        collected_minor: await acct('tax_payable'), note: 'Configured tax rules only; no tax or e-invoicing compliance is claimed.',
        configured: await trx.selectFrom('tenant_settings').select(['tax_label', 'tax_rate_bp', 'prices_include_tax']).where('tenant_id', '=', access.tenantId).executeTakeFirst() ?? null,
      },
      daily,
    };
  });
}

// ── Receipts & invoices ─────────────────────────────────────────────────────
export async function sellerSnapshot(trx: Tx, tenantId: string) {
  const t = await trx.selectFrom('tenants').select(['name']).where('id', '=', tenantId).executeTakeFirstOrThrow();
  const s = await trx.selectFrom('tenant_settings').select(['legal_name', 'tax_number', 'legal_address', 'contact_phone', 'contact_email', 'tax_label', 'tax_rate_bp', 'prices_include_tax']).where('tenant_id', '=', tenantId).executeTakeFirstOrThrow();
  return { name: t.name, legal_name: s.legal_name, tax_number: s.tax_number, address: s.legal_address, phone: s.contact_phone, email: s.contact_email, tax: { label: s.tax_label, rate_bp: s.tax_rate_bp, prices_include_tax: s.prices_include_tax } };
}

/** Receipt for a captured payment (one per payment; immutable). */
export async function issueReceipt(access: TenantAccess, actor: AuditActor, paymentId: string) {
  return withTenant(access.tenantId, async (trx) => {
    const existing = await trx.selectFrom('invoices').select('id').where('payment_id', '=', paymentId).where('kind', '=', 'receipt').executeTakeFirst();
    if (existing) return existing;
    const p = await trx.selectFrom('payments').selectAll().where('id', '=', paymentId).executeTakeFirst();
    if (!p || p.status !== 'captured') throw Errors.notFound('payment');
    let buyer: Record<string, unknown> = {};
    let description = 'Payment';
    if (p.booking_id) {
      const b = await trx.selectFrom('bookings as b').innerJoin('tenant_customers as c', 'c.id', 'b.tenant_customer_id').select(['b.number', 'c.display_name']).where('b.id', '=', p.booking_id).executeTakeFirstOrThrow();
      buyer = { name: b.display_name }; description = `${p.kind === 'deposit' ? 'Deposit' : 'Payment'} — booking ${b.number}`;
    } else if (p.order_id) {
      const o = await trx.selectFrom('orders as o').innerJoin('tenant_customers as c', 'c.id', 'o.tenant_customer_id').select(['o.number', 'c.display_name']).where('o.id', '=', p.order_id).executeTakeFirstOrThrow();
      buyer = { name: o.display_name }; description = `Payment — order ${o.number}`;
    }
    const number = await nextReadableNumber(trx, access.tenantId, 'receipt');
    const inv = await trx.insertInto('invoices').values({
      tenant_id: access.tenantId, number, kind: 'receipt', booking_id: p.booking_id, order_id: p.order_id, payment_id: p.id,
      seller_snapshot: JSON.stringify(await sellerSnapshot(trx, access.tenantId)), buyer_snapshot: JSON.stringify(buyer),
      subtotal_minor: p.amount_minor, total_minor: p.amount_minor, currency: p.currency, tax_basis: JSON.stringify({ note: 'Receipt of payment; see invoice for tax breakdown.' }), created_by: actor.userId,
    }).returning('id').executeTakeFirstOrThrow();
    await trx.insertInto('invoice_items').values({ tenant_id: access.tenantId, invoice_id: inv.id, description, quantity: 1, unit_price_minor: p.amount_minor, line_total_minor: p.amount_minor }).execute();
    await audit(trx, actor, 'finance.receipt_issued', { tenantId: access.tenantId, targetType: 'invoice', targetId: inv.id });
    return inv;
  });
}

/** Invoice for a completed booking, built from its snapshot (never today's catalog). */
export async function issueBookingInvoice(access: TenantAccess, actor: AuditActor, bookingId: string) {
  return withTenant(access.tenantId, async (trx) => {
    const existing = await trx.selectFrom('invoices').select('id').where('booking_id', '=', bookingId).where('kind', '=', 'invoice').executeTakeFirst();
    if (existing) return existing;
    const b = await trx.selectFrom('bookings as b').innerJoin('tenant_customers as c', 'c.id', 'b.tenant_customer_id').selectAll('b').select(['c.display_name']).where('b.id', '=', bookingId).executeTakeFirst();
    if (!b || b.status !== 'completed') throw Errors.invalid('booking_not_completed', 'Invoices are issued for completed bookings');
    const items = await trx.selectFrom('booking_items').selectAll().where('booking_id', '=', bookingId).where('superseded_at', 'is', null).orderBy('sequence').execute();
    const number = await nextReadableNumber(trx, access.tenantId, 'invoice');
    const inv = await trx.insertInto('invoices').values({
      tenant_id: access.tenantId, number, kind: 'invoice', booking_id: bookingId, seller_snapshot: JSON.stringify(await sellerSnapshot(trx, access.tenantId)),
      buyer_snapshot: JSON.stringify({ name: b.display_name }), subtotal_minor: b.subtotal_minor, discount_minor: b.discount_minor, tax_minor: b.tax_minor, total_minor: b.total_minor,
      currency: b.currency, tax_basis: JSON.stringify((b.policy_snapshot as Record<string, unknown>) ?? {}), created_by: actor.userId,
    }).returning('id').executeTakeFirstOrThrow();
    await trx.insertInto('invoice_items').values(items.map((i) => ({
      tenant_id: access.tenantId, invoice_id: inv.id, description: `${i.service_name_ar ?? i.service_name_en ?? ''} — ${i.staff_name}`, quantity: 1, unit_price_minor: i.line_total_minor, line_total_minor: i.line_total_minor,
    }))).execute();
    await audit(trx, actor, 'finance.invoice_issued', { tenantId: access.tenantId, targetType: 'invoice', targetId: inv.id });
    return inv;
  });
}

export async function getInvoice(tenantId: string, id: string) {
  return withTenant(tenantId, async (trx) => {
    const inv = await trx.selectFrom('invoices').selectAll().where('id', '=', id).executeTakeFirst();
    if (!inv) throw Errors.notFound('invoice');
    const items = await trx.selectFrom('invoice_items').selectAll().where('invoice_id', '=', id).execute();
    const tenant = await trx.selectFrom('tenants').select(['slug', 'timezone']).where('id', '=', tenantId).executeTakeFirstOrThrow();
    return { ...inv, items, tenant };
  });
}

// ── Exports (protected, tenant-scoped, audited) ─────────────────────────────
function csv(rows: Array<Record<string, unknown>>) {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]!);
  const esc = (v: unknown) => {
    const s = v instanceof Date ? v.toISOString() : v == null ? '' : String(v);
    // Neutralise spreadsheet formula injection.
    const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
}

export async function listExports(access: TenantAccess) {
  return withTenant(access.tenantId, async (trx) => {
    const rows = await trx.selectFrom('finance_exports').select(['id', 'kind', 'period_start', 'period_end', 'status', 'row_count', 'asset_id', 'error', 'created_at', 'finished_at'])
      .orderBy('created_at', 'desc').limit(100).execute();
    return rows.map(({ asset_id, ...r }) => ({ ...r, download_url: r.status === 'succeeded' && asset_id ? `/api/v1/media/${asset_id}` : null }));
  });
}

/** The period report as rows (line, amount, basis) — the same figures as the Finance page, hosting lines included. */
export async function reportRows(access: TenantAccess, fromISO: string, toISO: string) {
  const r = await financeReport(access, fromISO, toISO);
  const row = (line: string, amount: number | null, basis = '') => ({ line, amount_minor: amount, currency: 'SAR', basis });
  return [
    row('booking_value', r.booking_value.amount_minor, r.booking_value.basis),
    row('completed_service_sales', r.completed_service_sales.amount_minor, r.completed_service_sales.basis),
    row('product_sales', r.product_sales.amount_minor, r.product_sales.basis),
    row('hosting_revenue', r.hosting_revenue.amount_minor, r.hosting_revenue.basis),
    row('hosting_product_addons_in_product_sales', r.hosting_revenue.product_addons_minor, 'Reference only; already inside product_sales.'),
    row('hosting_addons_discount', r.hosting_revenue.discounts_minor, 'Listing-wide add-ons discount (D5b).'),
    row('hosting_refunds', r.hosting_revenue.refunds_minor, 'Refunds to experts, net of the tax reversed.'),
    row('hosting_net_revenue', r.hosting_revenue.net_minor, 'hosting_revenue − hosting_addons_discount − hosting_refunds'),
    row('hosting_expense', r.hosting_expense.amount_minor, r.hosting_expense.basis),
    row('hosting_dues_unpaid', r.hosting_expense.dues_minor, 'Approved space charges not paid yet (included in hosting_expense).'),
    row('collections', r.collections.total_minor, r.collections.basis),
    row('deposits_outstanding', r.deposits_outstanding.amount_minor, r.deposits_outstanding.basis),
    row('receivables', r.receivables.amount_minor, r.receivables.basis),
    row('refunds_completed', r.refunds.completed_minor, r.refunds.basis),
    row('expenses', r.expenses.total_minor),
    row('product_costs', r.product_costs.amount_minor, r.product_costs.basis),
    row('material_costs', r.material_costs.amount_minor, r.material_costs.basis),
    row('commissions', r.commissions.amount_minor),
    row('salaries', r.salaries.amount_minor, r.salaries.basis),
    row('tax_collected', r.tax.collected_minor, r.tax.note),
    row('profit', r.profit.amount_minor, r.profit.status === 'computed' ? r.profit.formula : `costs incomplete: ${(r.profit.missing ?? []).join(', ')}`),
  ];
}

export async function createExport(access: TenantAccess, actor: AuditActor, kind: 'bookings' | 'payments' | 'journal' | 'expenses' | 'summary', fromISO: string, toISO: string) {
  const from = DateTime.fromISO(fromISO, { zone: access.timezone }).startOf('day').toJSDate();
  const to = DateTime.fromISO(toISO, { zone: access.timezone }).endOf('day').toJSDate();
  const exp = await withTenant(access.tenantId, (trx) => trx.insertInto('finance_exports').values({ tenant_id: access.tenantId, kind, period_start: fromISO, period_end: toISO, status: 'running', requested_by: actor.userId }).returning('id').executeTakeFirstOrThrow());
  try {
    const rows = kind === 'summary' ? await reportRows(access, fromISO, toISO) : await withTenant(access.tenantId, async (trx): Promise<Array<Record<string, unknown>>> => {
      if (kind === 'bookings') return trx.selectFrom('bookings').select(['number', 'status', 'payment_status', 'starts_at', 'subtotal_minor', 'discount_minor', 'tax_minor', 'total_minor', 'paid_minor', 'refunded_minor', 'source']).where('starts_at', '>=', from).where('starts_at', '<=', to).orderBy('starts_at').execute();
      if (kind === 'payments') return trx.selectFrom('payments').select(['id', 'purpose', 'kind', 'method', 'amount_minor', 'currency', 'status', 'captured_at', 'provider', 'needs_reconciliation']).where('created_at', '>=', from).where('created_at', '<=', to).orderBy('created_at').execute();
      if (kind === 'journal') return trx.selectFrom('financial_entries').select(['entry_group_id', 'account', 'debit_minor', 'credit_minor', 'ref_type', 'ref_id', 'occurred_at', 'memo']).where('occurred_at', '>=', from).where('occurred_at', '<=', to).orderBy('occurred_at').execute();
      return trx.selectFrom('expenses').select(['category', 'amount_minor', 'incurred_on', 'description', 'voided_at', 'void_reason']).where('incurred_on', '>=', fromISO).where('incurred_on', '<=', toISO).orderBy('incurred_on').execute();
    });
    const body = Buffer.from(`﻿${csv(rows)}`, 'utf8');
    const assetId = randomUUID();
    const key = `tenants/${access.tenantId}/exports/${assetId}.csv`;
    await storage().put(key, body, 'text/csv');
    await withTenant(access.tenantId, async (trx) => {
      await trx.insertInto('assets').values({ id: assetId, tenant_id: access.tenantId, kind: 'document', purpose: 'export', storage_key: key, mime: 'text/csv; charset=utf-8', bytes: Math.max(1, body.length), status: 'ready', visibility: 'private', uploaded_by: actor.userId }).execute();
      await trx.updateTable('finance_exports').set({ status: 'succeeded', asset_id: assetId, row_count: rows.length, finished_at: new Date() }).where('id', '=', exp.id).execute();
      await audit(trx, actor, 'finance.export_created', { tenantId: access.tenantId, targetType: 'finance_export', targetId: exp.id, data: { kind, from: fromISO, to: toISO, rows: rows.length } });
    });
    return { id: exp.id, status: 'succeeded', row_count: rows.length, download_url: `/api/v1/media/${assetId}` };
  } catch (e) {
    await withTenant(access.tenantId, (trx) => trx.updateTable('finance_exports').set({ status: 'failed', error: (e as Error).message.slice(0, 300), finished_at: new Date() }).where('id', '=', exp.id).execute());
    throw e;
  }
}
