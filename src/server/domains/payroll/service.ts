import { DateTime } from 'luxon';
import { sql } from 'kysely';
import { z } from 'zod';
import { withTenant, type Tx } from '../../db/client';
import { Errors } from '../../http/errors';
import { audit, type AuditActor } from '../../infra/audit';
import { nextReadableNumber } from '../../infra/counters';
import type { TenantAccess } from '../../tenancy/access';
import { post, type Account, type Line } from '../finance/journal';

/**
 * Payroll.
 *
 *   net = base salary (pro-rated) + service commission + product commission
 *         + tips + bonuses − deductions − advance instalments
 *
 * Commission is decided by the business per CATEGORY, not per service:
 *   - services: on/off, a rate, optional monthly sales tiers;
 *   - products: on/off (off until the business switches it on), a rate,
 *     optional tiers. Product sales count for the staff member recorded as
 *     the order's seller.
 * The highest tier whose threshold a staff member's monthly sales in that
 * category reached sets the rate for ALL her sales of that category that month.
 *
 * A month is a draft until it is closed. Closing freezes one payslip per staff
 * member, records exactly what it settled (sales lines, entries, instalments),
 * and posts the payroll journal. Months close once and in order; anything
 * recorded after a close carries into the next month automatically.
 */

export const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_MINOR = 100_000_000_000;
const PAID_ORDER = ['paid', 'preparing', 'ready', 'collected'] as const;

export type PayrollEntryKind = 'bonus' | 'deduction' | 'advance' | 'tip';
export type CommissionCategory = 'services' | 'products';
export type Tier = { threshold_minor: number; rate_bp: number };
export type CategoryPolicy = { enabled: boolean; rate_bp: number; tiers: Tier[] };
type Settle = { source_type: 'booking_item' | 'order_item' | 'entry' | 'advance_installment'; source_id: string; part: number; amount_minor: number };
type EntryLine = { id: string; kind: PayrollEntryKind; amount_minor: number; effective_on: string; note: string | null; installment?: { index: number; of: number } };

type Amounts = {
  base_full_minor: number; days_employed: number; days_in_month: number; base_minor: number;
  service_sales_minor: number; service_count: number; service_rate_bp: number; service_commission_minor: number;
  product_sales_minor: number; product_count: number; product_rate_bp: number; product_commission_minor: number;
  commission_minor: number; tips_minor: number; bonus_minor: number; deduction_minor: number; advance_minor: number; net_minor: number;
};
type Row = Amounts & { staff_id: string; staff_name: string; entries: EntryLine[]; settle: Settle[] };

const ZERO = (): Amounts => ({
  base_full_minor: 0, days_employed: 0, days_in_month: 0, base_minor: 0,
  service_sales_minor: 0, service_count: 0, service_rate_bp: 0, service_commission_minor: 0,
  product_sales_minor: 0, product_count: 0, product_rate_bp: 0, product_commission_minor: 0,
  commission_minor: 0, tips_minor: 0, bonus_minor: 0, deduction_minor: 0, advance_minor: 0, net_minor: 0,
});
const TOTAL_KEYS = ['base_minor', 'service_sales_minor', 'service_commission_minor', 'product_sales_minor', 'product_commission_minor', 'commission_minor',
  'tips_minor', 'bonus_minor', 'deduction_minor', 'advance_minor', 'net_minor'] as const;
type Totals = Record<(typeof TOTAL_KEYS)[number], number>;

function monthStart(month: string, tz: string) {
  return DateTime.fromISO(`${month}-01`, { zone: tz }).startOf('month');
}
export function currentMonth(tz: string) {
  return DateTime.now().setZone(tz).toFormat('yyyy-MM');
}
function requireMonth(month: string) {
  if (!MONTH_RE.test(month)) throw Errors.invalid('invalid_month', 'Month must be YYYY-MM');
}
const monthOf = (periodMonth: string) => periodMonth.slice(0, 7);
const addMonths = (month: string, n: number) => DateTime.fromISO(`${month}-01`).plus({ months: n }).toFormat('yyyy-MM');

async function latestRun(trx: Tx) {
  return trx.selectFrom('payroll_runs').selectAll().orderBy('period_month', 'desc').limit(1).executeTakeFirst();
}

/** Signed journal line: a positive amount is a debit, a negative one a credit. */
const signed = (account: Account, amount: number): Line => (amount >= 0 ? { account, debit: amount } : { account, credit: -amount });
const PAYOUT_ACCOUNT = { cash: 'cash_on_hand', bank_transfer: 'bank' } as const;
const TIP_ACCOUNT = { cash: 'cash_on_hand', pos_terminal: 'provider_clearing' } as const;

// ── Pure rules (unit-tested) ────────────────────────────────────────────────
/** The rate for a month's sales: the highest tier reached, else the base rate; 0 when the category is off. */
export function tierRate(p: CategoryPolicy, salesMinor: number) {
  if (!p.enabled) return 0;
  let rate = p.rate_bp;
  for (const t of [...p.tiers].sort((a, b) => a.threshold_minor - b.threshold_minor)) if (salesMinor >= t.threshold_minor) rate = t.rate_bp;
  return rate;
}

/** Calendar days employed in [monthStart, monthEnd] given optional employment dates. */
export function employedDays(monthFirst: string, monthLast: string, start: string | null, end: string | null) {
  const from = start && start > monthFirst ? start : monthFirst;
  const to = end && end < monthLast ? end : monthLast;
  if (to < from) return 0;
  return Math.round(DateTime.fromISO(to).diff(DateTime.fromISO(from), 'days').days) + 1;
}

/** Instalment k (0-based) of an advance split into n parts; the last part takes the remainder. */
export function installmentAmount(total: number, n: number, k: number) {
  const part = Math.floor(total / n);
  return k === n - 1 ? total - part * (n - 1) : part;
}

/** A sales line's commission base: its share of the document's net of tax, after refunds. */
function salesBase(line: number, subtotal: number, total: number, tax: number, refunded: number) {
  if (subtotal <= 0 || total <= 0) return 0;
  const kept = Math.max(0, total - refunded) / total;
  return Math.max(0, Math.round((total - tax) * kept * (line / subtotal)));
}

// ── Policy ──────────────────────────────────────────────────────────────────
const tierSchema = z.object({ threshold_minor: z.number().int().positive().max(MAX_MINOR), rate_bp: z.number().int().min(0).max(10000) }).strict();
const categorySchema = z.object({
  enabled: z.boolean(),
  rate_bp: z.number().int().min(0).max(10000),
  tiers: z.array(tierSchema).max(10),
}).strict().superRefine((v, ctx) => {
  const th = v.tiers.map((t) => t.threshold_minor);
  if (th.some((x, i) => i > 0 && x <= th[i - 1]!)) ctx.addIssue({ code: 'custom', path: ['tiers'], message: 'Tier thresholds must increase' });
});
export const commissionPolicyInput = z.object({
  tips_enabled: z.boolean().optional(),
  services: categorySchema.optional(),
  products: categorySchema.optional(),
}).strict();

async function loadPolicies(trx: Tx): Promise<Record<CommissionCategory, CategoryPolicy>> {
  const rows = await trx.selectFrom('commission_policies').select(['category', 'enabled', 'rate_bp', 'tiers']).execute();
  const get = (c: CommissionCategory): CategoryPolicy => {
    const r = rows.find((x) => x.category === c);
    return r ? { enabled: r.enabled, rate_bp: r.rate_bp, tiers: ((r.tiers as Tier[] | null) ?? []).slice().sort((a, b) => a.threshold_minor - b.threshold_minor) } : { enabled: false, rate_bp: 0, tiers: [] };
  };
  return { services: get('services'), products: get('products') };
}

export async function getCommissionPolicy(access: TenantAccess) {
  return withTenant(access.tenantId, async (trx) => {
    const st = await trx.selectFrom('tenant_settings').select(['tips_enabled']).where('tenant_id', '=', access.tenantId).executeTakeFirst();
    return { tips_enabled: st?.tips_enabled ?? true, ...(await loadPolicies(trx)) };
  });
}

export async function updateCommissionPolicy(access: TenantAccess, actor: AuditActor, input: z.infer<typeof commissionPolicyInput>) {
  await withTenant(access.tenantId, async (trx) => {
    if (input.tips_enabled !== undefined) await trx.updateTable('tenant_settings').set({ tips_enabled: input.tips_enabled }).where('tenant_id', '=', access.tenantId).execute();
    for (const category of ['services', 'products'] as const) {
      const p = input[category];
      if (!p) continue;
      const tiers = JSON.stringify([...p.tiers].sort((a, b) => a.threshold_minor - b.threshold_minor));
      await trx.insertInto('commission_policies').values({ tenant_id: access.tenantId, category, enabled: p.enabled, rate_bp: p.rate_bp, tiers, updated_by: actor.userId })
        .onConflict((oc) => oc.columns(['tenant_id', 'category']).doUpdateSet({ enabled: p.enabled, rate_bp: p.rate_bp, tiers, updated_by: actor.userId })).execute();
    }
    await audit(trx, actor, 'payroll.commission_policy_updated', { tenantId: access.tenantId, targetType: 'tenant', targetId: access.tenantId, data: input });
  });
  return getCommissionPolicy(access);
}

// ── Draft computation ───────────────────────────────────────────────────────
/**
 * Unsettled items up to the end of `month`. Sales and entries use a lower
 * bound: the start of the latest closed month (so items recorded after that
 * close carry forward), or the start of `month` when nothing is closed yet.
 * Advance instalments are due by schedule (one per month from the advance's month).
 */
async function computeDraft(trx: Tx, tz: string, month: string, opts: { onlyStaff?: string; lock?: boolean } = {}) {
  const start = monthStart(month, tz);
  const end = start.endOf('month');
  const first = start.toISODate()!;
  const last = end.toISODate()!;
  const latest = await latestRun(trx);
  const latestStart = latest ? monthStart(monthOf(latest.period_month), tz) : null;
  const lower = latestStart && latestStart < start ? latestStart : start;
  const policies = await loadPolicies(trx);
  const only = opts.onlyStaff;

  const notSettled = (type: Settle['source_type'], ref: string) => sql<boolean>`not exists (select 1 from payroll_settled_items s where s.source_type = ${type} and s.source_id = ${sql.ref(ref)})`;

  // Service sales: current items of bookings completed in the window.
  let sq = trx.selectFrom('booking_items as bi').innerJoin('bookings as b', 'b.id', 'bi.booking_id')
    .select(['bi.id', 'bi.staff_id', 'bi.line_total_minor', 'b.subtotal_minor', 'b.total_minor', 'b.tax_minor', 'b.refunded_minor'])
    .where('b.status', '=', 'completed').where('bi.superseded_at', 'is', null)
    .where(sql<boolean>`exists (select 1 from booking_events e where e.booking_id = b.id and e.to_status = 'completed' and e.created_at >= ${lower.toJSDate()} and e.created_at <= ${end.toJSDate()})`)
    .where(notSettled('booking_item', 'bi.id'));
  if (only) sq = sq.where('bi.staff_id', '=', only);
  const services = await sq.execute();

  // Product sales: lines of paid orders with a recorded seller, paid in the window.
  let pq = trx.selectFrom('order_items as oi').innerJoin('orders as o', 'o.id', 'oi.order_id')
    .select(['oi.id', 'o.sold_by_staff_id as staff_id', 'oi.line_total_minor', 'o.subtotal_minor', 'o.total_minor', 'o.tax_minor', 'o.refunded_minor'])
    .where('o.sold_by_staff_id', 'is not', null).where('o.status', 'in', [...PAID_ORDER])
    .where(sql<boolean>`exists (select 1 from order_events e where e.order_id = o.id and e.to_status = 'paid' and e.created_at >= ${lower.toJSDate()} and e.created_at <= ${end.toJSDate()})`)
    .where(notSettled('order_item', 'oi.id'));
  if (only) pq = pq.where('o.sold_by_staff_id', '=', only);
  const products = await pq.execute();

  // Bonuses, deductions and tips in the window.
  let eq = trx.selectFrom('payroll_entries as p').select(['p.id', 'p.staff_id', 'p.kind', 'p.amount_minor', 'p.effective_on', 'p.note'])
    .where('p.voided_at', 'is', null).where('p.kind', '!=', 'advance')
    .where('p.effective_on', '>=', lower.toISODate()!).where('p.effective_on', '<=', last)
    .where(notSettled('entry', 'p.id')).orderBy('p.effective_on').orderBy('p.created_at');
  if (only) eq = eq.where('p.staff_id', '=', only);
  // When closing, lock the entries so a concurrent void waits and then sees them settled.
  const entries = await (opts.lock ? eq.forUpdate('p') : eq).execute();

  // Advances with instalments still due by this month.
  let aq = trx.selectFrom('payroll_entries as p').select(['p.id', 'p.staff_id', 'p.amount_minor', 'p.installments', 'p.effective_on', 'p.note'])
    .where('p.voided_at', 'is', null).where('p.kind', '=', 'advance').where('p.effective_on', '<=', last);
  if (only) aq = aq.where('p.staff_id', '=', only);
  const advances = await (opts.lock ? aq.forUpdate('p') : aq).execute();
  const doneParts = advances.length
    ? await trx.selectFrom('payroll_settled_items').select(['source_id', 'part']).where('source_type', '=', 'advance_installment').where('source_id', 'in', advances.map((a) => a.id)).execute()
    : [];

  // Base salaries, pro-rated by employment days in the month.
  let bq = trx.selectFrom('staff_pay_profiles as pp').innerJoin('staff_profiles as sp', 'sp.id', 'pp.staff_id')
    .select(['pp.staff_id', 'pp.base_salary_minor', 'pp.employment_start', 'pp.employment_end'])
    .where('pp.base_salary_minor', '>', 0)
    .where((w) => w.or([w('sp.archived_at', 'is', null), w('pp.employment_end', 'is not', null)]));
  if (only) bq = bq.where('pp.staff_id', '=', only);
  const bases = await bq.execute();

  const daysInMonth = start.daysInMonth!;
  const rows = new Map<string, Row>();
  const row = (staffId: string) => {
    let r = rows.get(staffId);
    if (!r) { r = { ...ZERO(), days_in_month: daysInMonth, staff_id: staffId, staff_name: '', entries: [], settle: [] }; rows.set(staffId, r); }
    return r;
  };
  for (const b of bases) {
    const days = employedDays(first, last, b.employment_start, b.employment_end);
    if (days <= 0) continue;
    const r = row(b.staff_id);
    r.base_full_minor = b.base_salary_minor;
    r.days_employed = days;
    r.base_minor = Math.round((b.base_salary_minor * days) / daysInMonth);
  }
  for (const s of services) {
    const base = salesBase(s.line_total_minor, s.subtotal_minor, s.total_minor, s.tax_minor, s.refunded_minor);
    const r = row(s.staff_id);
    r.service_sales_minor += base; r.service_count += 1;
    r.settle.push({ source_type: 'booking_item', source_id: s.id, part: 0, amount_minor: base });
  }
  for (const p of products) {
    const base = salesBase(p.line_total_minor, p.subtotal_minor, p.total_minor, p.tax_minor, p.refunded_minor);
    const r = row(p.staff_id!);
    r.product_sales_minor += base; r.product_count += 1;
    r.settle.push({ source_type: 'order_item', source_id: p.id, part: 0, amount_minor: base });
  }
  for (const e of entries) {
    const r = row(e.staff_id);
    const kind = e.kind as PayrollEntryKind;
    if (kind === 'tip') r.tips_minor += e.amount_minor;
    else if (kind === 'bonus') r.bonus_minor += e.amount_minor;
    else r.deduction_minor += e.amount_minor;
    r.entries.push({ id: e.id, kind, amount_minor: e.amount_minor, effective_on: e.effective_on, note: e.note });
    r.settle.push({ source_type: 'entry', source_id: e.id, part: 0, amount_minor: e.amount_minor });
  }
  for (const a of advances) {
    const done = new Set(doneParts.filter((d) => d.source_id === a.id).map((d) => d.part));
    const firstMonth = a.effective_on.slice(0, 7);
    for (let k = 0; k < a.installments; k++) {
      if (done.has(k) || addMonths(firstMonth, k) > month) continue;
      const amount = installmentAmount(a.amount_minor, a.installments, k);
      const r = row(a.staff_id);
      r.advance_minor += amount;
      r.entries.push({ id: a.id, kind: 'advance', amount_minor: amount, effective_on: a.effective_on, note: a.note, installment: { index: k + 1, of: a.installments } });
      r.settle.push({ source_type: 'advance_installment', source_id: a.id, part: k, amount_minor: amount });
    }
  }
  if (rows.size) {
    const names = await trx.selectFrom('staff_profiles').select(['id', 'display_name']).where('id', 'in', [...rows.keys()]).execute();
    for (const n of names) rows.get(n.id)!.staff_name = n.display_name;
  }
  const list = [...rows.values()].map((r) => {
    r.service_rate_bp = tierRate(policies.services, r.service_sales_minor);
    r.product_rate_bp = tierRate(policies.products, r.product_sales_minor);
    r.service_commission_minor = Math.round((r.service_sales_minor * r.service_rate_bp) / 10000);
    r.product_commission_minor = Math.round((r.product_sales_minor * r.product_rate_bp) / 10000);
    r.commission_minor = r.service_commission_minor + r.product_commission_minor;
    r.net_minor = r.base_minor + r.commission_minor + r.tips_minor + r.bonus_minor - r.deduction_minor - r.advance_minor;
    return r;
  }).sort((a, b) => a.staff_name.localeCompare(b.staff_name, 'ar'));
  const totals = Object.fromEntries(TOTAL_KEYS.map((k) => [k, list.reduce((a, r) => a + r[k], 0)])) as Totals;
  return { rows: list, totals, policies, carried_from: lower < start ? lower.toFormat('yyyy-MM') : null };
}

/** Why a month cannot be closed now (null = it can). */
function closeBlocker(month: string, tz: string, latest: { period_month: string } | undefined) {
  if (month > currentMonth(tz)) return { code: 'payroll_month_in_future' as const, expected: null };
  if (latest) {
    const expected = addMonths(monthOf(latest.period_month), 1);
    if (month <= monthOf(latest.period_month)) return { code: 'payroll_already_closed' as const, expected };
    if (month !== expected) return { code: 'payroll_month_out_of_order' as const, expected };
  }
  return null;
}

const publicRow = ({ settle: _s, ...r }: Row) => r;

// ── Payroll sheet ───────────────────────────────────────────────────────────
export async function payrollSheet(access: TenantAccess, month: string) {
  requireMonth(month);
  const tz = access.timezone;
  return withTenant(access.tenantId, async (trx) => {
    const run = await trx.selectFrom('payroll_runs').selectAll().where('period_month', '=', `${month}-01`).executeTakeFirst();
    const latest = await latestRun(trx);
    const latestMonth = latest ? monthOf(latest.period_month) : null;
    if (run) {
      const slips = await trx.selectFrom('payroll_slips as s').leftJoin('payroll_slip_payments as p', 'p.slip_id', 's.id')
        .selectAll('s').select(['p.paid_at', 'p.method as paid_method', 'p.reference as paid_reference'])
        .where('s.run_id', '=', run.id).orderBy('s.staff_name').execute();
      const rows = slips.map(({ lines, run_id: _r, tenant_id: _t, created_at: _c, ...s }) => ({ ...s, entries: lines as EntryLine[] }));
      const totals = Object.fromEntries(TOTAL_KEYS.map((k) => [k, rows.reduce((a, r) => a + r[k], 0)])) as Totals;
      return {
        month, status: 'closed' as const, timezone: tz, currency: run.currency,
        run: { id: run.id, closed_at: run.closed_at, staff_count: run.staff_count },
        rows, totals: { ...totals, paid_minor: rows.filter((s) => s.paid_at).reduce((a, s) => a + s.net_minor, 0) },
        close: { allowed: false, blocker: 'payroll_already_closed', expected_month: latestMonth ? addMonths(latestMonth, 1) : null },
        latest_closed_month: latestMonth,
      };
    }
    const draft = await computeDraft(trx, tz, month);
    const blocker = closeBlocker(month, tz, latest);
    return {
      month, status: 'open' as const, timezone: tz, currency: access.currency, run: null,
      rows: draft.rows.map(publicRow), totals: { ...draft.totals, paid_minor: 0 }, carried_from: draft.carried_from, policies: draft.policies,
      close: { allowed: !blocker && !access.readOnly, blocker: blocker?.code ?? null, expected_month: blocker?.expected ?? (latestMonth ? addMonths(latestMonth, 1) : null) },
      latest_closed_month: latestMonth,
    };
  });
}

// ── Month close ─────────────────────────────────────────────────────────────
export async function closeMonth(access: TenantAccess, actor: AuditActor, month: string) {
  requireMonth(month);
  const tz = access.timezone;
  return withTenant(access.tenantId, async (trx) => {
    // One close at a time per business; the unique month and the settled-item
    // primary key are the second line of defence.
    await sql`select pg_advisory_xact_lock(hashtextextended(${`payroll:${access.tenantId}`}, 0))`.execute(trx);
    const latest = await latestRun(trx);
    const blocker = closeBlocker(month, tz, latest);
    if (blocker) throw Errors.conflict(blocker.code, 'This month cannot be closed now', { expected_month: blocker.expected });

    const draft = await computeDraft(trx, tz, month, { lock: true });
    const t = draft.totals;
    const run = await trx.insertInto('payroll_runs').values({
      tenant_id: access.tenantId, period_month: `${month}-01`, currency: access.currency, staff_count: draft.rows.length,
      base_minor: t.base_minor, commission_minor: t.commission_minor, tips_minor: t.tips_minor, bonus_minor: t.bonus_minor,
      deduction_minor: t.deduction_minor, advance_minor: t.advance_minor, net_minor: t.net_minor, closed_by: actor.userId,
    }).returning(['id', 'closed_at']).executeTakeFirstOrThrow();

    for (const r of draft.rows) {
      const { staff_id, staff_name, entries, settle: _s, ...amounts } = r;
      const number = await nextReadableNumber(trx, access.tenantId, 'payslip');
      await trx.insertInto('payroll_slips').values({ tenant_id: access.tenantId, run_id: run.id, staff_id, number, staff_name, ...amounts, lines: JSON.stringify(entries) }).execute();
    }
    const settled = draft.rows.flatMap((r) => r.settle.map((s) => ({ tenant_id: access.tenantId, run_id: run.id, ...s })));
    for (let i = 0; i < settled.length; i += 500) await trx.insertInto('payroll_settled_items').values(settled.slice(i, i + 500)).execute();

    const monthEnd = monthStart(month, tz).endOf('month').toJSDate();
    await post(trx, access.tenantId, { type: 'payroll_close', id: run.id }, [
      signed('salaries_expense', t.base_minor + t.bonus_minor - t.deduction_minor),
      signed('commissions_expense', t.commission_minor),
      signed('tips_payable', t.tips_minor),
      signed('staff_advances', -t.advance_minor),
      signed('payroll_payable', -t.net_minor),
    ], { createdBy: actor.userId, occurredAt: monthEnd < new Date() ? monthEnd : new Date(), memo: `payroll ${month}` });

    await audit(trx, actor, 'payroll.month_closed', { tenantId: access.tenantId, targetType: 'payroll_run', targetId: run.id, data: { month, staff: draft.rows.length, net_minor: t.net_minor } });
    return { id: run.id, month, staff_count: draft.rows.length, net_minor: t.net_minor };
  });
}

// ── Payslips ────────────────────────────────────────────────────────────────
export const paySlipInput = z.object({ method: z.enum(['cash', 'bank_transfer']).default('bank_transfer'), reference: z.string().trim().max(80).optional() }).strict();

export async function paySlip(access: TenantAccess, actor: AuditActor, slipId: string, input: z.infer<typeof paySlipInput>) {
  return withTenant(access.tenantId, async (trx) => {
    // Payslips are append-only (no row lock possible); the unique slip_id makes a payment happen once.
    const slip = await trx.selectFrom('payroll_slips').select(['id', 'net_minor', 'number', 'staff_id']).where('id', '=', slipId).executeTakeFirst();
    if (!slip) throw Errors.notFound('payslip');
    if (slip.net_minor <= 0) throw Errors.invalid('payslip_nothing_to_pay', 'This payslip has no amount to pay');
    const p = await trx.insertInto('payroll_slip_payments').values({
      tenant_id: access.tenantId, slip_id: slipId, amount_minor: slip.net_minor, method: input.method, reference: input.reference || null, paid_by: actor.userId,
    }).onConflict((oc) => oc.column('slip_id').doNothing()).returning(['id', 'paid_at']).executeTakeFirst();
    if (!p) throw Errors.conflict('payslip_already_paid');
    await post(trx, access.tenantId, { type: 'payroll_payment', id: p.id }, [{ account: 'payroll_payable', debit: slip.net_minor }, { account: PAYOUT_ACCOUNT[input.method], credit: slip.net_minor }],
      { createdBy: actor.userId, memo: `payslip ${slip.number}` });
    await audit(trx, actor, 'payroll.slip_paid', { tenantId: access.tenantId, targetType: 'payroll_slip', targetId: slipId, data: { amount_minor: slip.net_minor, method: input.method, reference: input.reference ?? null } });
    return { id: slipId, paid_at: p.paid_at, amount_minor: slip.net_minor, method: input.method };
  });
}

/** A payslip with what is needed to print it. Staff may only read their own. */
export async function getSlip(access: TenantAccess, slipId: string) {
  return withTenant(access.tenantId, async (trx) => {
    const s = await trx.selectFrom('payroll_slips as s').innerJoin('payroll_runs as r', 'r.id', 's.run_id').leftJoin('payroll_slip_payments as p', 'p.slip_id', 's.id')
      .selectAll('s').select(['r.period_month', 'r.currency', 'r.closed_at', 'p.paid_at', 'p.method as paid_method', 'p.reference as paid_reference'])
      .where('s.id', '=', slipId).executeTakeFirst();
    const canAll = access.capabilities.has('payroll.view');
    if (!s || (!canAll && !(access.capabilities.has('payroll.view_own') && access.staffProfileId === s.staff_id))) throw Errors.notFound('payslip');
    const t = await trx.selectFrom('tenants').select(['name']).where('id', '=', access.tenantId).executeTakeFirstOrThrow();
    const st = await trx.selectFrom('tenant_settings').select(['legal_name', 'legal_address', 'contact_phone']).where('tenant_id', '=', access.tenantId).executeTakeFirst();
    return { ...s, month: monthOf(s.period_month), employer: { name: st?.legal_name || t.name, address: st?.legal_address ?? null, phone: st?.contact_phone ?? null }, timezone: access.timezone };
  });
}

// ── Staff: my earnings ──────────────────────────────────────────────────────
export async function myEarnings(access: TenantAccess, month: string) {
  requireMonth(month);
  const staffId = access.staffProfileId;
  if (!staffId) throw Errors.notFound('staff_profile');
  return withTenant(access.tenantId, async (trx) => {
    const slips = await trx.selectFrom('payroll_slips as s').innerJoin('payroll_runs as r', 'r.id', 's.run_id').leftJoin('payroll_slip_payments as p', 'p.slip_id', 's.id')
      .selectAll('s').select(['r.period_month', 'p.paid_at'])
      .where('s.staff_id', '=', staffId).orderBy('r.period_month', 'desc').limit(12).execute();
    const closed = await trx.selectFrom('payroll_runs').select('id').where('period_month', '=', `${month}-01`).executeTakeFirst();
    const clean = slips.map(({ lines, run_id: _r, tenant_id: _t, ...s }) => ({ ...s, month: monthOf(s.period_month), entries: lines as EntryLine[] }));
    let current: ReturnType<typeof publicRow> | (typeof clean)[number] | null = null;
    if (closed) current = clean.find((s) => s.month === month) ?? null;
    else {
      const draft = await computeDraft(trx, access.timezone, month, { onlyStaff: staffId });
      const r = draft.rows[0];
      current = r ? publicRow(r) : { ...ZERO(), staff_id: staffId, staff_name: '', entries: [] };
    }
    return { month, status: closed ? 'closed' as const : 'open' as const, currency: access.currency, current, slips: clean };
  });
}

// ── Payroll entries: bonus, deduction, advance (instalments), tip ───────────
export const payrollEntryInput = z.object({
  staff_id: z.string().uuid(),
  kind: z.enum(['bonus', 'deduction', 'advance', 'tip']),
  amount_minor: z.number().int().positive().max(MAX_MINOR),
  effective_on: z.string().regex(DATE_RE).optional(),
  note: z.string().trim().max(500).optional(),
  /** Tip: cash or pos_terminal. Advance payout: cash or bank_transfer. */
  method: z.enum(['cash', 'pos_terminal', 'bank_transfer']).optional(),
  /** Advance only: repaid over this many months (1–36). */
  installments: z.number().int().min(1).max(36).optional(),
  booking_id: z.string().uuid().optional(),
}).strict();

export const tipInput = z.object({
  booking_id: z.string().uuid(),
  staff_id: z.string().uuid(),
  amount_minor: z.number().int().positive().max(MAX_MINOR),
  method: z.enum(['cash', 'pos_terminal']),
  note: z.string().trim().max(500).optional(),
}).strict();

export async function addPayrollEntry(access: TenantAccess, actor: AuditActor, input: z.infer<typeof payrollEntryInput>) {
  const tz = access.timezone;
  const effectiveOn = input.effective_on ?? DateTime.now().setZone(tz).toISODate()!;
  if (!DateTime.fromISO(effectiveOn).isValid) throw Errors.invalid('invalid_date');
  let method: 'cash' | 'pos_terminal' | 'bank_transfer' | null = null;
  if (input.kind === 'tip') {
    if (!input.method || input.method === 'bank_transfer') throw Errors.invalid('tip_method_required', 'Choose how the tip was paid');
    method = input.method;
  } else if (input.kind === 'advance') {
    method = input.method ?? 'cash';
    if (method === 'pos_terminal') throw Errors.invalid('advance_method_invalid', 'An advance is paid in cash or by bank transfer');
  }
  const installments = input.kind === 'advance' ? input.installments ?? 1 : 1;
  if (input.kind !== 'advance' && input.installments && input.installments > 1) throw Errors.invalid('installments_only_for_advances');
  if (input.kind !== 'tip' && input.booking_id) throw Errors.invalid('booking_only_for_tips');
  if (input.kind === 'advance' && input.amount_minor < installments) throw Errors.invalid('advance_too_small_for_installments');
  return withTenant(access.tenantId, async (trx) => {
    const latest = await latestRun(trx);
    if (latest && effectiveOn < latest.period_month) throw Errors.conflict('payroll_period_closed', 'That month is already closed', { latest_closed_month: monthOf(latest.period_month) });
    const staff = await trx.selectFrom('staff_profiles').select(['id', 'display_name']).where('id', '=', input.staff_id).where('archived_at', 'is', null).executeTakeFirst();
    if (!staff) throw Errors.notFound('staff');
    if (input.kind === 'tip') {
      const s = await trx.selectFrom('tenant_settings').select('tips_enabled').where('tenant_id', '=', access.tenantId).executeTakeFirst();
      if (s && !s.tips_enabled) throw Errors.conflict('tips_disabled', 'Tips are switched off for this business');
      if (input.booking_id) {
        const b = await trx.selectFrom('bookings').select(['id', 'status']).where('id', '=', input.booking_id).executeTakeFirst();
        if (!b) throw Errors.notFound('booking');
        if (!['confirmed', 'checked_in', 'in_service', 'completed'].includes(b.status)) throw Errors.conflict('invalid_transition', `Booking is ${b.status}`);
        const onBooking = await trx.selectFrom('booking_items').select('id').where('booking_id', '=', input.booking_id).where('staff_id', '=', input.staff_id)
          .where('superseded_at', 'is', null).executeTakeFirst();
        if (!onBooking) throw Errors.invalid('tip_staff_not_on_booking', 'This staff member did not serve this booking');
      }
    }
    const e = await trx.insertInto('payroll_entries').values({
      tenant_id: access.tenantId, staff_id: input.staff_id, kind: input.kind, amount_minor: input.amount_minor, currency: access.currency,
      effective_on: effectiveOn, installments, note: input.note || null, booking_id: input.kind === 'tip' ? input.booking_id ?? null : null,
      method, created_by: actor.userId,
    }).returningAll().executeTakeFirstOrThrow();
    if (e.kind === 'tip') {
      await post(trx, access.tenantId, { type: 'payroll_tip', id: e.id }, [{ account: TIP_ACCOUNT[e.method as 'cash' | 'pos_terminal'], debit: e.amount_minor }, { account: 'tips_payable', credit: e.amount_minor }],
        { createdBy: actor.userId, memo: `tip ${staff.display_name}` });
    } else if (e.kind === 'advance') {
      await post(trx, access.tenantId, { type: 'payroll_advance', id: e.id }, [{ account: 'staff_advances', debit: e.amount_minor }, { account: PAYOUT_ACCOUNT[e.method as 'cash' | 'bank_transfer'], credit: e.amount_minor }],
        { createdBy: actor.userId, memo: `advance ${staff.display_name} (${installments})` });
    }
    await audit(trx, actor, `payroll.${e.kind}_recorded`, { tenantId: access.tenantId, targetType: 'payroll_entry', targetId: e.id, data: { staff_id: e.staff_id, amount_minor: e.amount_minor, effective_on: e.effective_on, installments, booking_id: e.booking_id } });
    return e;
  });
}

export async function voidPayrollEntry(access: TenantAccess, actor: AuditActor, id: string, reason: string) {
  return withTenant(access.tenantId, async (trx) => {
    const e = await trx.selectFrom('payroll_entries').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
    if (!e) throw Errors.notFound('payroll_entry');
    if (e.voided_at) throw Errors.conflict('already_void');
    if (await trx.selectFrom('payroll_settled_items').select('source_id').where('source_type', 'in', ['entry', 'advance_installment']).where('source_id', '=', id).executeTakeFirst()) {
      throw Errors.conflict('payroll_entry_settled', 'This entry is part of a closed month');
    }
    await trx.updateTable('payroll_entries').set({ voided_at: new Date(), voided_by: actor.userId, void_reason: reason }).where('id', '=', id).execute();
    const refType = e.kind === 'tip' ? 'payroll_tip' : e.kind === 'advance' ? 'payroll_advance' : null;
    if (refType) {
      const orig = await trx.selectFrom('financial_entries').select('entry_group_id').where('ref_type', '=', refType).where('ref_id', '=', id).executeTakeFirst();
      const lines: Line[] = e.kind === 'tip'
        ? [{ account: 'tips_payable', debit: e.amount_minor }, { account: TIP_ACCOUNT[e.method as 'cash' | 'pos_terminal'], credit: e.amount_minor }]
        : [{ account: PAYOUT_ACCOUNT[e.method as 'cash' | 'bank_transfer'], debit: e.amount_minor }, { account: 'staff_advances', credit: e.amount_minor }];
      await post(trx, access.tenantId, { type: `${refType}_void`, id }, lines, { createdBy: actor.userId, reversesGroupId: orig?.entry_group_id ?? null, memo: reason });
    }
    await audit(trx, actor, 'payroll.entry_voided', { tenantId: access.tenantId, targetType: 'payroll_entry', targetId: id, data: { reason, kind: e.kind } });
    return { id, voided: true };
  });
}

/** Entries dated in a month, plus advances still being repaid (with how many instalments are settled). */
export async function listPayrollEntries(access: TenantAccess, month: string) {
  requireMonth(month);
  const start = `${month}-01`;
  const end = DateTime.fromISO(start).endOf('month').toISODate()!;
  return withTenant(access.tenantId, async (trx) => {
    const rows = await trx.selectFrom('payroll_entries as p').innerJoin('staff_profiles as sp', 'sp.id', 'p.staff_id').leftJoin('bookings as b', 'b.id', 'p.booking_id')
      .select(['p.id', 'p.staff_id', 'sp.display_name as staff_name', 'p.kind', 'p.amount_minor', 'p.effective_on', 'p.installments', 'p.note', 'p.method', 'p.booking_id',
        'b.number as booking_number', 'p.voided_at', 'p.void_reason', 'p.created_at',
        sql<number>`(select count(*)::int from payroll_settled_items s where s.source_id = p.id and s.source_type in ('entry', 'advance_installment'))`.as('settled_parts'),
        sql<string | null>`(select to_char(min(r.period_month), 'YYYY-MM') from payroll_settled_items s join payroll_runs r on r.id = s.run_id where s.source_id = p.id and s.source_type = 'entry')`.as('settled_in')])
      .where((w) => w.or([
        w.and([w('p.effective_on', '>=', start), w('p.effective_on', '<=', end)]),
        // Advances started earlier that still have instalments to repay.
        w.and([w('p.kind', '=', 'advance'), w('p.effective_on', '<', start), w('p.voided_at', 'is', null),
          sql<boolean>`(select count(*) from payroll_settled_items s where s.source_id = p.id and s.source_type = 'advance_installment') < p.installments`]),
      ]))
      .orderBy('p.effective_on', 'desc').orderBy('p.created_at', 'desc').limit(500).execute();
    return rows;
  });
}

// ── Base salaries and employment dates ──────────────────────────────────────
export const baseSalaryInput = z.object({
  base_salary_minor: z.number().int().min(0).max(MAX_MINOR),
  employment_start: z.string().regex(DATE_RE).nullable().optional(),
  employment_end: z.string().regex(DATE_RE).nullable().optional(),
}).strict().refine((v) => !v.employment_start || !v.employment_end || v.employment_end >= v.employment_start, { path: ['employment_end'], message: 'End date is before the start date' });

export async function listPayProfiles(access: TenantAccess) {
  return withTenant(access.tenantId, (trx) => trx.selectFrom('staff_profiles as sp').leftJoin('staff_pay_profiles as pp', 'pp.staff_id', 'sp.id')
    .select(['sp.id as staff_id', 'sp.display_name', 'sp.title_ar', 'sp.title_en', 'sp.is_active', sql<number>`coalesce(pp.base_salary_minor, 0)::bigint`.as('base_salary_minor'),
      'pp.employment_start', 'pp.employment_end', 'pp.updated_at'])
    .where('sp.archived_at', 'is', null).orderBy('sp.sort').orderBy('sp.display_name').execute());
}

export async function setBaseSalary(access: TenantAccess, actor: AuditActor, staffId: string, input: z.infer<typeof baseSalaryInput>) {
  return withTenant(access.tenantId, async (trx) => {
    const staff = await trx.selectFrom('staff_profiles').select('id').where('id', '=', staffId).where('archived_at', 'is', null).executeTakeFirst();
    if (!staff) throw Errors.notFound('staff');
    const before = await trx.selectFrom('staff_pay_profiles').select(['base_salary_minor', 'employment_start', 'employment_end']).where('staff_id', '=', staffId).executeTakeFirst();
    const values = {
      base_salary_minor: input.base_salary_minor,
      employment_start: input.employment_start === undefined ? before?.employment_start ?? null : input.employment_start,
      employment_end: input.employment_end === undefined ? before?.employment_end ?? null : input.employment_end,
    };
    if (values.employment_start && values.employment_end && values.employment_end < values.employment_start) throw Errors.invalid('employment_dates_invalid', 'End date is before the start date');
    await trx.insertInto('staff_pay_profiles').values({ tenant_id: access.tenantId, staff_id: staffId, ...values, updated_by: actor.userId })
      .onConflict((oc) => oc.columns(['tenant_id', 'staff_id']).doUpdateSet({ ...values, updated_by: actor.userId })).execute();
    await audit(trx, actor, 'payroll.base_salary_set', { tenantId: access.tenantId, targetType: 'staff', targetId: staffId, data: { from: before ?? null, to: values } });
    return { staff_id: staffId, ...values };
  });
}

// ── Order seller (product commission attribution) ───────────────────────────
export const orderSellerInput = z.object({ staff_id: z.string().uuid().nullable() }).strict();

export async function setOrderSeller(access: TenantAccess, actor: AuditActor, orderId: string, input: z.infer<typeof orderSellerInput>) {
  return withTenant(access.tenantId, async (trx) => {
    const o = await trx.selectFrom('orders').select(['id', 'status', 'sold_by_staff_id']).where('id', '=', orderId).forUpdate().executeTakeFirst();
    if (!o) throw Errors.notFound('order');
    if (o.status === 'cancelled') throw Errors.conflict('invalid_transition', 'Order is cancelled');
    const settled = await trx.selectFrom('payroll_settled_items as s').innerJoin('order_items as oi', 'oi.id', 's.source_id')
      .select('s.source_id').where('s.source_type', '=', 'order_item').where('oi.order_id', '=', orderId).executeTakeFirst();
    if (settled) throw Errors.conflict('order_commission_settled', 'This order is already in a closed payroll month');
    if (input.staff_id) {
      const sp = await trx.selectFrom('staff_profiles').select('id').where('id', '=', input.staff_id).where('archived_at', 'is', null).executeTakeFirst();
      if (!sp) throw Errors.notFound('staff');
    }
    await trx.updateTable('orders').set({ sold_by_staff_id: input.staff_id }).where('id', '=', orderId).execute();
    await audit(trx, actor, 'order.seller_set', { tenantId: access.tenantId, targetType: 'order', targetId: orderId, data: { from: o.sold_by_staff_id, to: input.staff_id } });
    return { id: orderId, sold_by_staff_id: input.staff_id };
  });
}
