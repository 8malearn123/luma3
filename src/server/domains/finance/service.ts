import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import { sql } from 'kysely';
import { z } from 'zod';
import { withTenant, type Tx } from '../../db/client';
import { Errors } from '../../http/errors';
import { audit, type AuditActor } from '../../infra/audit';
import { nextReadableNumber } from '../../infra/counters';
import { storage } from '../../infra/storage';
import type { TenantAccess } from '../../tenancy/access';
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

// ── Commission rules ────────────────────────────────────────────────────────
export const commissionRuleInput = z.object({
  staff_id: z.string().uuid().nullable().optional(),
  service_id: z.string().uuid().nullable().optional(),
  kind: z.enum(['percent', 'fixed']),
  rate_bp: z.number().int().min(0).max(10000).optional(),
  amount_minor: z.number().int().min(0).max(10_000_000).optional(),
  effective_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  effective_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
}).strict().refine((v) => (v.kind === 'percent' ? v.rate_bp != null : v.amount_minor != null), 'Rate or amount required');

export async function createCommissionRule(access: TenantAccess, actor: AuditActor, input: z.infer<typeof commissionRuleInput>) {
  return withTenant(access.tenantId, async (trx) => {
    const r = await trx.insertInto('commission_rules').values({
      tenant_id: access.tenantId, staff_id: input.staff_id ?? null, service_id: input.service_id ?? null, kind: input.kind, rate_bp: input.rate_bp ?? null,
      amount_minor: input.amount_minor ?? null, effective_from: input.effective_from ?? DateTime.now().toISODate()!, effective_to: input.effective_to ?? null, created_by: actor.userId,
    }).returningAll().executeTakeFirstOrThrow();
    await audit(trx, actor, 'finance.commission_rule_created', { tenantId: access.tenantId, targetType: 'commission_rule', targetId: r.id, data: input });
    return r;
  });
}

export async function listCommissionRules(access: TenantAccess) {
  return withTenant(access.tenantId, (trx) => trx.selectFrom('commission_rules').selectAll().orderBy('created_at', 'desc').execute());
}

export async function deactivateCommissionRule(access: TenantAccess, actor: AuditActor, id: string) {
  return withTenant(access.tenantId, async (trx) => {
    const r = await trx.updateTable('commission_rules').set({ is_active: false, effective_to: DateTime.now().toISODate()! }).where('id', '=', id).returning('id').executeTakeFirst();
    if (!r) throw Errors.notFound('commission_rule');
    await audit(trx, actor, 'finance.commission_rule_deactivated', { tenantId: access.tenantId, targetType: 'commission_rule', targetId: id });
    return r;
  });
}

/** Explicit correction after a refund: an offsetting reversal entry, never an edit. */
export async function reverseCommission(access: TenantAccess, actor: AuditActor, entryId: string, reason: string) {
  return withTenant(access.tenantId, async (trx) => {
    const e = await trx.selectFrom('commission_entries').selectAll().where('id', '=', entryId).where('kind', '=', 'earned').executeTakeFirst();
    if (!e) throw Errors.notFound('commission_entry');
    const prior = await trx.selectFrom('commission_entries').select('id').where('reverses_entry_id', '=', entryId).executeTakeFirst();
    if (prior) throw Errors.conflict('already_reversed');
    const r = await trx.insertInto('commission_entries').values({
      tenant_id: access.tenantId, staff_id: e.staff_id, booking_item_id: e.booking_item_id, kind: 'reversal', base_minor: -e.base_minor, amount_minor: -e.amount_minor,
      rule_snapshot: JSON.stringify(e.rule_snapshot), reason, reverses_entry_id: e.id, created_by: actor.userId,
    }).returning('id').executeTakeFirstOrThrow();
    await post(trx, access.tenantId, { type: 'commission_reversal', id: r.id }, [{ account: 'commissions_payable', debit: e.amount_minor }, { account: 'commissions_expense', credit: e.amount_minor }], { createdBy: actor.userId, memo: reason });
    await audit(trx, actor, 'finance.commission_reversed', { tenantId: access.tenantId, targetType: 'commission_entry', targetId: entryId, data: { reason } });
    return { id: r.id };
  });
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
    const commissions = await trx.selectFrom('commission_entries').select([sql<number>`coalesce(sum(amount_minor),0)::bigint`.as('v')]).where('created_at', '>=', from).where('created_at', '<=', to).executeTakeFirstOrThrow();
    // Product cost: needs a unit cost on every sold line.
    const cogs = await trx.selectFrom('order_items as i').innerJoin('orders as o', 'o.id', 'i.order_id')
      .select([sql<number>`coalesce(sum(i.unit_cost_minor * i.quantity),0)::bigint`.as('v'), sql<number>`count(*) filter (where i.unit_cost_minor is null)::int`.as('missing')])
      .where('o.status', 'in', ['paid', 'preparing', 'ready', 'collected']).where('o.created_at', '>=', from).where('o.created_at', '<=', to).executeTakeFirstOrThrow();
    // Material cost: consumption movements need a cost per unit on the item.
    const materials = await trx.selectFrom('stock_movements as m').innerJoin('inventory_items as it', 'it.id', 'm.inventory_item_id')
      .select([sql<number>`coalesce(sum(-m.quantity * it.cost_per_unit_minor),0)::bigint`.as('v'), sql<number>`count(*) filter (where it.cost_per_unit_minor is null)::int`.as('missing')])
      .where('m.kind', '=', 'consumption').where('m.created_at', '>=', from).where('m.created_at', '<=', to).executeTakeFirstOrThrow();
    const servicesWithoutCost = await trx.selectFrom('services').select(sql<number>`count(*)::int`.as('n')).where('archived_at', 'is', null).where('cost_minor', 'is', null).executeTakeFirstOrThrow();

    const serviceRevenue = await acct('service_revenue');
    const productRevenue = await acct('product_revenue');
    const expenseTotal = expenses.reduce((a, e) => a + e.v, 0);
    const missing: string[] = [];
    if (cogs.missing > 0) missing.push('product_unit_costs');
    if (materials.missing > 0) missing.push('material_unit_costs');
    if (servicesWithoutCost.n > 0 && materials.v === 0) missing.push('service_costs_or_recipes');
    const profit = missing.length ? null : serviceRevenue + productRevenue - expenseTotal - cogs.v - Math.round(materials.v) - commissions.v;
    return {
      period: { from: fromISO, to: toISO, timezone: tz },
      booking_value: { amount_minor: bookingValue.v, count: bookingValue.n, basis: 'Total of confirmed/attended/completed bookings starting in the period (not revenue).' },
      completed_service_sales: { amount_minor: serviceRevenue, basis: 'Service revenue recognised at completion (net of tax), plus fees retained under booking policy, delivered membership sessions and expired gift-card balances.' },
      product_sales: { amount_minor: productRevenue, basis: 'Product revenue recognised when an order is paid (net of tax).' },
      collections: { by_method: collections, total_minor: collections.reduce((a, c) => a + c.v, 0), basis: 'Money captured in the period (cash basis), including deposits.' },
      deposits_outstanding: { amount_minor: await balance('customer_deposits', 1), basis: 'Customer prepayments for services not yet delivered (a liability, not revenue).' },
      receivables: { amount_minor: await balance('accounts_receivable', -1), basis: 'Completed services not yet fully paid.' },
      refunds: { completed_minor: refundsDone.v, pending_minor: refundsPending.v, basis: 'Completed = provider/cashier confirmed. Pending refunds are not refunded yet.' },
      discounts: { amount_minor: discounts.v + orderDiscounts.v },
      provider_fees: { amount_minor: null, basis: 'Not reported by the sandbox provider; reconciled from settlements when a real provider is connected.' },
      expenses: { by_category: expenses, total_minor: expenseTotal },
      product_costs: { amount_minor: cogs.v, complete: cogs.missing === 0, missing_lines: cogs.missing },
      material_costs: { amount_minor: Math.round(materials.v), complete: materials.missing === 0 },
      commissions: { amount_minor: commissions.v },
      profit: profit === null
        ? { status: 'costs_incomplete', missing, amount_minor: null }
        : { status: 'computed', amount_minor: profit, formula: 'service sales + product sales − expenses − product costs − material costs − commissions' },
      tax: { collected_minor: await acct('tax_payable'), note: 'Configured tax rules only; no tax or e-invoicing compliance is claimed.' },
    };
  });
}

// ── Receipts & invoices ─────────────────────────────────────────────────────
async function sellerSnapshot(trx: Tx, tenantId: string) {
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

export async function createExport(access: TenantAccess, actor: AuditActor, kind: 'bookings' | 'payments' | 'journal' | 'expenses', fromISO: string, toISO: string) {
  const from = DateTime.fromISO(fromISO, { zone: access.timezone }).startOf('day').toJSDate();
  const to = DateTime.fromISO(toISO, { zone: access.timezone }).endOf('day').toJSDate();
  const exp = await withTenant(access.tenantId, (trx) => trx.insertInto('finance_exports').values({ tenant_id: access.tenantId, kind, period_start: fromISO, period_end: toISO, status: 'running', requested_by: actor.userId }).returning('id').executeTakeFirstOrThrow());
  try {
    const rows = await withTenant(access.tenantId, async (trx): Promise<Array<Record<string, unknown>>> => {
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
