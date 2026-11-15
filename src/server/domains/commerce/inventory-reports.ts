import { DateTime } from 'luxon';
import { sql } from 'kysely';
import type { z } from 'zod';
import { withTenant, type Tx } from '../../db/client';
import { Errors } from '../../http/errors';
import { featureEnabled, hasCapability, type TenantAccess } from '../../tenancy/access';
import { listBalances } from './locations';
import { listTransfers } from './transfers';
import { listInvoices, listReceipts } from './purchasing';
import { getSettings } from './locations';
import type { reportQuery } from '@/shared/schemas/inventory';

/**
 * Inventory & operations reports (requirement 8). Quantities are in each
 * item's base unit; money only with costs.view, at the cost frozen on each
 * movement (never today's average). Material usage figures describe stock,
 * not people: they must not be used on their own to judge staff performance.
 */
export const REPORTS = ['balances', 'movements', 'transfers', 'consumption', 'expected_vs_actual', 'waste', 'shortages', 'near_expiry', 'service_material_cost', 'supplier_matching', 'valuation'] as const;
export type ReportKind = (typeof REPORTS)[number];
const ADVANCED = new Set<ReportKind>(['consumption', 'expected_vs_actual', 'waste', 'service_material_cost', 'supplier_matching']);

type Q = z.infer<typeof reportQuery>;

function period(access: TenantAccess, q: Q) {
  const tz = access.timezone;
  const to = q.to ? DateTime.fromISO(q.to, { zone: tz }).endOf('day') : DateTime.now().setZone(tz).endOf('day');
  const from = q.from ? DateTime.fromISO(q.from, { zone: tz }).startOf('day') : to.minus({ days: 29 }).startOf('day');
  return { from: from.toJSDate(), to: to.toJSDate(), fromISO: from.toISODate()!, toISO: to.toISODate()! };
}

export async function inventoryReport(access: TenantAccess, kind: ReportKind, q: Q) {
  if (ADVANCED.has(kind) && !featureEnabled(access, 'feature.inventory_reports_advanced')) throw Errors.planFeature('feature.inventory_reports_advanced');
  if (kind === 'supplier_matching' && !hasCapability(access, ['purchasing.manage', 'purchasing.pay', 'finance.view'])) throw Errors.forbidden();
  if (kind === 'valuation' && !hasCapability(access, 'costs.view')) throw Errors.forbidden();
  const costs = hasCapability(access, 'costs.view');
  const p = period(access, q);
  const note = { usage_note: 'Material usage describes stock movement. Do not judge staff performance from it alone.' };
  switch (kind) {
    case 'balances': return { kind, ...(await listBalances(access, { location_id: q.location_id, inventory_item_id: q.inventory_item_id, nonzero: '1', limit: 500, offset: 0 })) };
    case 'transfers': return { kind, items: await listTransfers(access) };
    case 'supplier_matching': return { kind, invoices: await listInvoices(access), received_not_invoiced: await listReceipts(access, { not_invoiced: true }) };
  }
  return withTenant(access.tenantId, async (trx) => {
    switch (kind) {
      case 'movements': return { kind, period: p, items: await movementLedger(trx, q, p, costs) };
      case 'consumption': return { kind, period: p, group: q.group ?? 'service', items: await consumptionBy(trx, q, p, costs), ...note };
      case 'expected_vs_actual': return { kind, period: p, items: await expectedVsActual(trx, q, p), ...note };
      case 'waste': return { kind, period: p, items: await waste(trx, q, p, costs) };
      case 'shortages': return { kind, ...(await shortages(trx)) };
      case 'near_expiry': return { kind, items: await nearExpiry(trx, access.tenantId) };
      case 'service_material_cost': return { kind, period: p, items: costs ? await serviceMaterialCost(trx, p) : [], ...note };
      case 'valuation': return { kind, ...(await valuation(trx)) };
      default: throw Errors.notFound('report');
    }
  });
}

async function movementLedger(trx: Tx, q: Q, p: ReturnType<typeof period>, costs: boolean) {
  let s = trx.selectFrom('stock_movements as m').innerJoin('inventory_items as i', 'i.id', 'm.inventory_item_id').leftJoin('stock_locations as l', 'l.id', 'm.location_id')
    .leftJoin('users as u', 'u.id', 'm.actor_user_id')
    .select(['m.id', 'm.created_at', 'm.kind', 'm.inventory_item_id', 'i.name as item_name', 'm.unit', 'm.quantity', 'm.location_id', 'l.name as location_name', 'm.location_on_hand_after',
      'm.reason', 'm.ref_type', 'm.document_type', 'm.document_id', 'm.reversal_of', 'm.unit_cost_minor', 'm.total_cost_minor', 'u.display_name as actor_name'])
    .where('m.created_at', '>=', p.from).where('m.created_at', '<=', p.to).where('m.kind', 'not in', ['reservation', 'release']);
  if (q.location_id) s = s.where('m.location_id', '=', q.location_id);
  if (q.inventory_item_id) s = s.where('m.inventory_item_id', '=', q.inventory_item_id);
  const rows = await s.orderBy('m.created_at', 'desc').limit(1000).execute();
  return rows.map(({ unit_cost_minor, total_cost_minor, ...r }) => ({ ...r, quantity: Number(r.quantity), location_on_hand_after: r.location_on_hand_after == null ? null : Number(r.location_on_hand_after),
    ...(costs ? { unit_cost_minor: unit_cost_minor == null ? null : Number(unit_cost_minor), total_cost_minor } : {}) }));
}

async function consumptionBy(trx: Tx, q: Q, p: ReturnType<typeof period>, costs: boolean) {
  const g = q.group ?? 'service';
  const key = {
    service: sql<string>`coalesce(sv.name_ar, sv.name_en, '—')`, booking: sql<string>`coalesce(b.number, '—')`, chair: sql<string>`coalesce(r.name, '—')`,
    performer: sql<string>`coalesce(sp.display_name, '—')`, item: sql<string>`i.name`, location: sql<string>`l.name`,
  }[g];
  let s = trx.selectFrom('material_consumptions as c').innerJoin('inventory_items as i', 'i.id', 'c.inventory_item_id').innerJoin('stock_locations as l', 'l.id', 'c.location_id')
    .leftJoin('services as sv', 'sv.id', 'c.service_id').leftJoin('bookings as b', 'b.id', 'c.booking_id').leftJoin('resources as r', 'r.id', 'c.resource_id')
    .leftJoin('staff_profiles as sp', 'sp.id', 'c.performer_staff_id')
    .select([key.as('group_label'), 'i.name as item_name', 'c.unit',
      sql<number>`count(*)::int`.as('lines'), sql<number>`sum(c.expected_qty)::float8`.as('expected_qty'), sql<number>`sum(coalesce(c.actual_qty, c.expected_qty))::float8`.as('actual_qty'),
      sql<number>`sum(c.posted_qty)::float8`.as('posted_qty'), sql<number>`sum(c.waste_qty)::float8`.as('waste_qty'), sql<number>`sum(c.shortage_qty)::float8`.as('shortage_qty'),
      sql<number>`sum(c.total_cost_minor)::bigint`.as('cost_minor')])
    .where('c.status', 'in', ['posted', 'shortage']).where('c.posted_at', '>=', p.from).where('c.posted_at', '<=', p.to);
  if (q.location_id) s = s.where('c.location_id', '=', q.location_id);
  if (q.inventory_item_id) s = s.where('c.inventory_item_id', '=', q.inventory_item_id);
  const rows = await s.groupBy([key, 'i.name', 'c.unit']).orderBy(key).orderBy('i.name').execute();
  return rows.map(({ cost_minor, ...r }) => ({ ...r, ...(costs ? { cost_minor } : {}) }));
}

async function expectedVsActual(trx: Tx, q: Q, p: ReturnType<typeof period>) {
  let s = trx.selectFrom('material_consumptions as c').innerJoin('inventory_items as i', 'i.id', 'c.inventory_item_id').leftJoin('services as sv', 'sv.id', 'c.service_id')
    .select(['c.service_id', 'sv.name_ar as service_name_ar', 'sv.name_en as service_name_en', 'c.inventory_item_id', 'i.name as item_name', 'c.unit',
      sql<number>`count(*)::int`.as('visits'), sql<number>`sum(c.expected_qty)::float8`.as('expected_qty'), sql<number>`sum(coalesce(c.actual_qty, c.expected_qty))::float8`.as('actual_qty')])
    .where('c.source', '=', 'service').where('c.status', 'in', ['posted', 'shortage']).where('c.posted_at', '>=', p.from).where('c.posted_at', '<=', p.to);
  if (q.inventory_item_id) s = s.where('c.inventory_item_id', '=', q.inventory_item_id);
  const rows = await s.groupBy(['c.service_id', 'sv.name_ar', 'sv.name_en', 'c.inventory_item_id', 'i.name', 'c.unit']).orderBy('i.name').execute();
  return rows.map((r) => ({ ...r, difference: Math.round((r.actual_qty - r.expected_qty) * 1000) / 1000, difference_pct: r.expected_qty > 0 ? Math.round(((r.actual_qty - r.expected_qty) / r.expected_qty) * 1000) / 10 : null }));
}

async function waste(trx: Tx, q: Q, p: ReturnType<typeof period>, costs: boolean) {
  let s = trx.selectFrom('stock_movements as m').innerJoin('inventory_items as i', 'i.id', 'm.inventory_item_id').leftJoin('stock_locations as l', 'l.id', 'm.location_id')
    .leftJoin('users as u', 'u.id', 'm.actor_user_id')
    .select(['m.id', 'm.created_at', 'i.name as item_name', 'm.unit', 'l.name as location_name', 'm.quantity', 'm.reason', 'm.total_cost_minor', 'u.display_name as actor_name'])
    .where('m.kind', '=', 'waste').where('m.created_at', '>=', p.from).where('m.created_at', '<=', p.to);
  if (q.location_id) s = s.where('m.location_id', '=', q.location_id);
  const rows = await s.orderBy('m.created_at', 'desc').limit(1000).execute();
  return rows.map(({ total_cost_minor, ...r }) => ({ ...r, quantity: -Number(r.quantity), ...(costs ? { cost_minor: total_cost_minor == null ? null : -total_cost_minor } : {}) }));
}

async function shortages(trx: Tx) {
  const tasks = await trx.selectFrom('inventory_tasks as t').leftJoin('inventory_items as i', 'i.id', 't.inventory_item_id').leftJoin('stock_locations as l', 'l.id', 't.location_id')
    .select(['t.id', 't.kind', 't.payload', 't.created_at', 'i.name as item_name', 'i.unit', 'l.name as location_name']).where('t.status', '=', 'open').where('t.kind', 'in', ['shortage', 'reorder'])
    .orderBy('t.created_at', 'desc').execute();
  const below = await trx.selectFrom('stock_balances as b').innerJoin('inventory_items as i', 'i.id', 'b.inventory_item_id').innerJoin('stock_locations as l', 'l.id', 'b.location_id')
    .select(['b.inventory_item_id', 'i.name as item_name', 'i.unit', 'b.location_id', 'l.name as location_name', sql<number>`(b.on_hand - b.reserved)::float8`.as('available'), sql<number>`b.reorder_level::float8`.as('reorder_level')])
    .where('b.reorder_level', 'is not', null).where(sql<boolean>`b.on_hand - b.reserved <= b.reorder_level`).orderBy('i.name').execute();
  return { tasks, below_reorder: below };
}

async function nearExpiry(trx: Tx, tenantId: string) {
  const { expiry_warning_days: days } = await getSettings(trx, tenantId);
  const limit = DateTime.now().plus({ days }).toISODate()!;
  const rows = await trx.selectFrom('stock_batch_balances as bb').innerJoin('stock_batches as b', 'b.id', 'bb.batch_id').innerJoin('inventory_items as i', 'i.id', 'b.inventory_item_id')
    .innerJoin('stock_locations as l', 'l.id', 'bb.location_id')
    .select(['b.id as batch_id', 'b.batch_no', 'b.expiry_date', 'i.name as item_name', 'i.unit', 'l.name as location_name', sql<number>`bb.quantity::float8`.as('quantity')])
    .where('bb.quantity', '>', 0).where('b.expiry_date', 'is not', null).where('b.expiry_date', '<=', limit).orderBy('b.expiry_date').execute();
  const today = DateTime.now().toISODate()!;
  return rows.map((r) => ({ ...r, expired: String(r.expiry_date) < today }));
}

async function serviceMaterialCost(trx: Tx, p: ReturnType<typeof period>) {
  return trx.selectFrom('material_consumptions as c').leftJoin('services as sv', 'sv.id', 'c.service_id')
    .select(['c.service_id', 'sv.name_ar as service_name_ar', 'sv.name_en as service_name_en',
      sql<number>`count(distinct c.booking_item_id)::int`.as('visits'), sql<number>`sum(c.total_cost_minor)::bigint`.as('cost_minor'),
      sql<number>`(sum(c.total_cost_minor)::float8 / nullif(count(distinct c.booking_item_id), 0))`.as('cost_per_visit_minor')])
    .where('c.source', '=', 'service').where('c.status', 'in', ['posted', 'shortage']).where('c.posted_at', '>=', p.from).where('c.posted_at', '<=', p.to)
    .groupBy(['c.service_id', 'sv.name_ar', 'sv.name_en']).orderBy(sql`sum(c.total_cost_minor)`, 'desc').execute();
}

/**
 * Inventory value (sum of item values at weighted average, plus value in
 * transit) against the journal's inventory account, accounts payable and
 * goods received not invoiced.
 */
export async function valuation(trx: Tx) {
  const items = await trx.selectFrom('inventory_items').select([sql<number>`coalesce(sum(stock_value_minor), 0)::bigint`.as('v'),
    sql<number>`count(*) filter (where avg_cost_minor is null and on_hand > 0)::int`.as('unknown')]).executeTakeFirstOrThrow();
  const transit = await trx.selectFrom('stock_transfer_lines as l').innerJoin('stock_transfers as t', 't.id', 'l.transfer_id')
    .select(sql<number>`coalesce(sum(l.total_cost_minor), 0)::bigint`.as('v')).where('t.status', '=', 'in_transit').executeTakeFirstOrThrow();
  const acct = async (a: string, sign: 1 | -1) => {
    const r = await trx.selectFrom('financial_entries').select(sql<number>`coalesce(sum(debit_minor - credit_minor), 0)::bigint`.as('v')).where('account', '=', a as never).executeTakeFirstOrThrow();
    return sign * r.v;
  };
  const ledger = await acct('inventory', 1);
  return {
    inventory_value_minor: items.v + transit.v, in_transit_value_minor: transit.v, items_without_cost: items.unknown,
    ledger_inventory_minor: ledger, difference_minor: ledger - (items.v + transit.v),
    accounts_payable_minor: await acct('accounts_payable', -1), received_not_invoiced_minor: await acct('goods_received_not_invoiced', -1),
    input_tax_minor: await acct('input_tax', 1), shrinkage_minor: await acct('inventory_shrinkage', 1),
    basis: 'Weighted average cost (D15). Operational ledger only: no inventory period close or landed-cost allocation.',
  };
}
