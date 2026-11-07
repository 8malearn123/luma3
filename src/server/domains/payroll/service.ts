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
 *   net = base salary + service commission + tips + bonuses − deductions − advances
 *
 * - Commission is earned on services only (finance/postings.ts earnCommissions).
 *   The business switches it on or off as a whole and per service, and sets a
 *   percentage per service. Product sales never earn commission.
 * - A month is a draft until it is closed. Closing freezes one payslip per
 *   staff member, records which commission entries and payroll entries it
 *   settled, and posts the payroll journal. Months close once and in order.
 * - Anything recorded after a close (a late commission, a reversal, a tip on
 *   the 30th) is unsettled, so it carries into the next month automatically.
 */

export const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_MINOR = 100_000_000_000;

export type PayrollEntryKind = 'bonus' | 'deduction' | 'advance' | 'tip';

type Totals = { base_minor: number; commission_minor: number; commission_count: number; tips_minor: number; bonus_minor: number; deduction_minor: number; advance_minor: number; net_minor: number };
type Row = Totals & { staff_id: string; staff_name: string; commission_ids: string[]; entries: Array<{ id: string; kind: PayrollEntryKind; amount_minor: number; effective_on: string; note: string | null }> };

const zeroTotals = (): Totals => ({ base_minor: 0, commission_minor: 0, commission_count: 0, tips_minor: 0, bonus_minor: 0, deduction_minor: 0, advance_minor: 0, net_minor: 0 });
const net = (t: Totals) => t.base_minor + t.commission_minor + t.tips_minor + t.bonus_minor - t.deduction_minor - t.advance_minor;

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
const nextMonth = (month: string) => DateTime.fromISO(`${month}-01`).plus({ months: 1 }).toFormat('yyyy-MM');

async function latestRun(trx: Tx) {
  return trx.selectFrom('payroll_runs').selectAll().orderBy('period_month', 'desc').limit(1).executeTakeFirst();
}

/** Signed journal line: a positive amount is a debit, a negative one a credit. */
const signed = (account: Account, amount: number): Line => (amount >= 0 ? { account, debit: amount } : { account, credit: -amount });

// ── Draft computation ───────────────────────────────────────────────────────
/**
 * Unsettled items up to the end of `month`. The lower bound is the start of the
 * latest closed month (so items recorded after that close carry forward), or
 * the start of `month` when nothing has been closed yet.
 */
async function computeDraft(trx: Tx, tz: string, month: string, onlyStaff?: string, lock = false) {
  const start = monthStart(month, tz);
  const end = start.endOf('month');
  const latest = await latestRun(trx);
  const latestStart = latest ? monthStart(monthOf(latest.period_month), tz) : null;
  const lower = latestStart && latestStart < start ? latestStart : start;

  let cq = trx.selectFrom('commission_entries as e')
    .select(['e.id', 'e.staff_id', 'e.kind', 'e.amount_minor'])
    .where('e.created_at', '>=', lower.toJSDate()).where('e.created_at', '<=', end.toJSDate())
    .where(({ not, exists, selectFrom }) => not(exists(selectFrom('payroll_settled_items as s').select('s.source_id').where('s.source_type', '=', 'commission').whereRef('s.source_id', '=', 'e.id'))));
  if (onlyStaff) cq = cq.where('e.staff_id', '=', onlyStaff);
  const commissions = await cq.execute();

  let eq = trx.selectFrom('payroll_entries as p')
    .select(['p.id', 'p.staff_id', 'p.kind', 'p.amount_minor', 'p.effective_on', 'p.note'])
    .where('p.voided_at', 'is', null)
    .where('p.effective_on', '>=', lower.toISODate()!).where('p.effective_on', '<=', end.toISODate()!)
    .where(({ not, exists, selectFrom }) => not(exists(selectFrom('payroll_settled_items as s').select('s.source_id').where('s.source_type', '=', 'entry').whereRef('s.source_id', '=', 'p.id'))))
    .orderBy('p.effective_on').orderBy('p.created_at');
  if (onlyStaff) eq = eq.where('p.staff_id', '=', onlyStaff);
  // When closing, lock the entries so a concurrent void waits and then sees them settled.
  const entries = await (lock ? eq.forUpdate('p') : eq).execute();

  let bq = trx.selectFrom('staff_pay_profiles as pp').innerJoin('staff_profiles as sp', 'sp.id', 'pp.staff_id')
    .select(['pp.staff_id', 'pp.base_salary_minor'])
    .where('pp.base_salary_minor', '>', 0).where('sp.archived_at', 'is', null).where('sp.is_active', '=', true);
  if (onlyStaff) bq = bq.where('pp.staff_id', '=', onlyStaff);
  const bases = await bq.execute();

  const rows = new Map<string, Row>();
  const row = (staffId: string) => {
    let r = rows.get(staffId);
    if (!r) { r = { ...zeroTotals(), staff_id: staffId, staff_name: '', commission_ids: [], entries: [] }; rows.set(staffId, r); }
    return r;
  };
  for (const b of bases) row(b.staff_id).base_minor = b.base_salary_minor;
  for (const c of commissions) {
    const r = row(c.staff_id);
    r.commission_minor += c.amount_minor;
    if (c.kind === 'earned') r.commission_count += 1;
    else if (c.kind === 'reversal') r.commission_count -= 1;
    r.commission_ids.push(c.id);
  }
  for (const e of entries) {
    const r = row(e.staff_id);
    const kind = e.kind as PayrollEntryKind;
    if (kind === 'tip') r.tips_minor += e.amount_minor;
    else if (kind === 'bonus') r.bonus_minor += e.amount_minor;
    else if (kind === 'deduction') r.deduction_minor += e.amount_minor;
    else r.advance_minor += e.amount_minor;
    r.entries.push({ id: e.id, kind, amount_minor: e.amount_minor, effective_on: e.effective_on, note: e.note });
  }
  if (rows.size) {
    const names = await trx.selectFrom('staff_profiles').select(['id', 'display_name']).where('id', 'in', [...rows.keys()]).execute();
    for (const n of names) rows.get(n.id)!.staff_name = n.display_name;
  }
  const list = [...rows.values()].map((r) => ({ ...r, commission_count: Math.max(0, r.commission_count), net_minor: net(r) }))
    .sort((a, b) => a.staff_name.localeCompare(b.staff_name, 'ar'));
  const totals = list.reduce<Totals>((t, r) => ({
    base_minor: t.base_minor + r.base_minor, commission_minor: t.commission_minor + r.commission_minor, commission_count: t.commission_count + r.commission_count,
    tips_minor: t.tips_minor + r.tips_minor, bonus_minor: t.bonus_minor + r.bonus_minor, deduction_minor: t.deduction_minor + r.deduction_minor,
    advance_minor: t.advance_minor + r.advance_minor, net_minor: t.net_minor + r.net_minor,
  }), zeroTotals());
  return { rows: list, totals, carried_from: lower < start ? lower.toFormat('yyyy-MM') : null };
}

/** Why a month cannot be closed now (null = it can). */
function closeBlocker(month: string, tz: string, latest: { period_month: string } | undefined) {
  if (month > currentMonth(tz)) return { code: 'payroll_month_in_future' as const, expected: null };
  if (latest) {
    const expected = nextMonth(monthOf(latest.period_month));
    if (month <= monthOf(latest.period_month)) return { code: 'payroll_already_closed' as const, expected };
    if (month !== expected) return { code: 'payroll_month_out_of_order' as const, expected };
  }
  return null;
}

const publicRow = ({ commission_ids: _c, ...r }: Row) => r;

// ── Payroll sheet ───────────────────────────────────────────────────────────
export async function payrollSheet(access: TenantAccess, month: string) {
  requireMonth(month);
  const tz = access.timezone;
  return withTenant(access.tenantId, async (trx) => {
    const run = await trx.selectFrom('payroll_runs').selectAll().where('period_month', '=', `${month}-01`).executeTakeFirst();
    const latest = await latestRun(trx);
    if (run) {
      const slips = await trx.selectFrom('payroll_slips as s').leftJoin('payroll_slip_payments as p', 'p.slip_id', 's.id')
        .select(['s.id', 's.number', 's.staff_id', 's.staff_name', 's.base_minor', 's.commission_minor', 's.commission_count', 's.tips_minor', 's.bonus_minor',
          's.deduction_minor', 's.advance_minor', 's.net_minor', 's.lines', 'p.paid_at', 'p.reference as paid_reference'])
        .where('s.run_id', '=', run.id).orderBy('s.staff_name').execute();
      return {
        month, status: 'closed' as const, timezone: tz, currency: run.currency,
        run: { id: run.id, closed_at: run.closed_at, staff_count: run.staff_count },
        rows: slips.map(({ lines, ...s }) => ({ ...s, entries: lines })),
        totals: {
          base_minor: run.base_minor, commission_minor: run.commission_minor, tips_minor: run.tips_minor, bonus_minor: run.bonus_minor,
          deduction_minor: run.deduction_minor, advance_minor: run.advance_minor, net_minor: run.net_minor,
          paid_minor: slips.filter((s) => s.paid_at).reduce((a, s) => a + s.net_minor, 0),
        },
        close: { allowed: false, blocker: 'payroll_already_closed', expected_month: latest ? nextMonth(monthOf(latest.period_month)) : null },
        latest_closed_month: latest ? monthOf(latest.period_month) : null,
      };
    }
    const draft = await computeDraft(trx, tz, month);
    const blocker = closeBlocker(month, tz, latest);
    return {
      month, status: 'open' as const, timezone: tz, currency: access.currency, run: null,
      rows: draft.rows.map(publicRow), totals: { ...draft.totals, paid_minor: 0 }, carried_from: draft.carried_from,
      close: { allowed: !blocker && !access.readOnly, blocker: blocker?.code ?? null, expected_month: blocker?.expected ?? (latest ? nextMonth(monthOf(latest.period_month)) : null) },
      latest_closed_month: latest ? monthOf(latest.period_month) : null,
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

    const draft = await computeDraft(trx, tz, month, undefined, true);
    const t = draft.totals;
    const run = await trx.insertInto('payroll_runs').values({
      tenant_id: access.tenantId, period_month: `${month}-01`, currency: access.currency, staff_count: draft.rows.length,
      base_minor: t.base_minor, commission_minor: t.commission_minor, tips_minor: t.tips_minor, bonus_minor: t.bonus_minor,
      deduction_minor: t.deduction_minor, advance_minor: t.advance_minor, net_minor: t.net_minor, closed_by: actor.userId,
    }).returning(['id', 'closed_at']).executeTakeFirstOrThrow();

    for (const r of draft.rows) {
      const number = await nextReadableNumber(trx, access.tenantId, 'payslip');
      await trx.insertInto('payroll_slips').values({
        tenant_id: access.tenantId, run_id: run.id, staff_id: r.staff_id, number, staff_name: r.staff_name,
        base_minor: r.base_minor, commission_minor: r.commission_minor, commission_count: r.commission_count, tips_minor: r.tips_minor,
        bonus_minor: r.bonus_minor, deduction_minor: r.deduction_minor, advance_minor: r.advance_minor, net_minor: r.net_minor,
        lines: JSON.stringify(r.entries),
      }).execute();
    }
    const settled = draft.rows.flatMap((r) => [
      ...r.commission_ids.map((id) => ({ tenant_id: access.tenantId, run_id: run.id, source_type: 'commission', source_id: id })),
      ...r.entries.map((e) => ({ tenant_id: access.tenantId, run_id: run.id, source_type: 'entry', source_id: e.id })),
    ]);
    for (let i = 0; i < settled.length; i += 500) await trx.insertInto('payroll_settled_items').values(settled.slice(i, i + 500)).execute();

    const monthEnd = monthStart(month, tz).endOf('month').toJSDate();
    await post(trx, access.tenantId, { type: 'payroll_close', id: run.id }, [
      signed('salaries_expense', t.base_minor + t.bonus_minor - t.deduction_minor),
      signed('commissions_payable', t.commission_minor),
      signed('tips_payable', t.tips_minor),
      signed('staff_advances', -t.advance_minor),
      signed('payroll_payable', -t.net_minor),
    ], { createdBy: actor.userId, occurredAt: monthEnd < new Date() ? monthEnd : new Date(), memo: `payroll ${month}` });

    await audit(trx, actor, 'payroll.month_closed', { tenantId: access.tenantId, targetType: 'payroll_run', targetId: run.id, data: { month, staff: draft.rows.length, net_minor: t.net_minor } });
    return { id: run.id, month, staff_count: draft.rows.length, net_minor: t.net_minor };
  });
}

// ── Payslips ────────────────────────────────────────────────────────────────
export const paySlipInput = z.object({ reference: z.string().trim().max(80).optional() }).strict();

export async function paySlip(access: TenantAccess, actor: AuditActor, slipId: string, input: z.infer<typeof paySlipInput>) {
  return withTenant(access.tenantId, async (trx) => {
    // Payslips are append-only (no row lock possible); the unique slip_id makes a payment happen once.
    const slip = await trx.selectFrom('payroll_slips').select(['id', 'net_minor', 'number', 'staff_id']).where('id', '=', slipId).executeTakeFirst();
    if (!slip) throw Errors.notFound('payslip');
    if (slip.net_minor <= 0) throw Errors.invalid('payslip_nothing_to_pay', 'This payslip has no amount to pay');
    const p = await trx.insertInto('payroll_slip_payments').values({
      tenant_id: access.tenantId, slip_id: slipId, amount_minor: slip.net_minor, reference: input.reference || null, paid_by: actor.userId,
    }).onConflict((oc) => oc.column('slip_id').doNothing()).returning(['id', 'paid_at']).executeTakeFirst();
    if (!p) throw Errors.conflict('payslip_already_paid');
    await post(trx, access.tenantId, { type: 'payroll_payment', id: p.id }, [{ account: 'payroll_payable', debit: slip.net_minor }, { account: 'cash_on_hand', credit: slip.net_minor }],
      { createdBy: actor.userId, memo: `payslip ${slip.number}` });
    await audit(trx, actor, 'payroll.slip_paid', { tenantId: access.tenantId, targetType: 'payroll_slip', targetId: slipId, data: { amount_minor: slip.net_minor, reference: input.reference ?? null } });
    return { id: slipId, paid_at: p.paid_at, amount_minor: slip.net_minor };
  });
}

/** A payslip with what is needed to print it. Staff may only read their own. */
export async function getSlip(access: TenantAccess, slipId: string) {
  return withTenant(access.tenantId, async (trx) => {
    const s = await trx.selectFrom('payroll_slips as s').innerJoin('payroll_runs as r', 'r.id', 's.run_id').leftJoin('payroll_slip_payments as p', 'p.slip_id', 's.id')
      .selectAll('s').select(['r.period_month', 'r.currency', 'r.closed_at', 'p.paid_at', 'p.reference as paid_reference'])
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
      .select(['s.id', 's.number', 'r.period_month', 's.base_minor', 's.commission_minor', 's.commission_count', 's.tips_minor', 's.bonus_minor', 's.deduction_minor',
        's.advance_minor', 's.net_minor', 'p.paid_at'])
      .where('s.staff_id', '=', staffId).orderBy('r.period_month', 'desc').limit(12).execute();
    const closed = await trx.selectFrom('payroll_runs').select('id').where('period_month', '=', `${month}-01`).executeTakeFirst();
    const slipFor = slips.find((s) => monthOf(s.period_month) === month);
    let current: Omit<Row, 'commission_ids'> | null = null;
    if (!closed) {
      const draft = await computeDraft(trx, access.timezone, month, staffId);
      const r = draft.rows[0];
      current = r ? publicRow(r) : { ...zeroTotals(), staff_id: staffId, staff_name: '', entries: [] };
    }
    return {
      month, status: closed ? 'closed' as const : 'open' as const, currency: access.currency,
      current: closed ? (slipFor ? { ...slipFor, entries: [] } : null) : current,
      slips: slips.map((s) => ({ ...s, month: monthOf(s.period_month) })),
    };
  });
}

// ── Payroll entries: bonus, deduction, advance, tip ─────────────────────────
export const payrollEntryInput = z.object({
  staff_id: z.string().uuid(),
  kind: z.enum(['bonus', 'deduction', 'advance', 'tip']),
  amount_minor: z.number().int().positive().max(MAX_MINOR),
  effective_on: z.string().regex(DATE_RE).optional(),
  note: z.string().trim().max(500).optional(),
  method: z.enum(['cash', 'pos_terminal']).optional(),
  booking_id: z.string().uuid().optional(),
}).strict();

export const tipInput = z.object({
  booking_id: z.string().uuid(),
  staff_id: z.string().uuid(),
  amount_minor: z.number().int().positive().max(MAX_MINOR),
  method: z.enum(['cash', 'pos_terminal']),
  note: z.string().trim().max(500).optional(),
}).strict();

const TIP_ACCOUNT = { cash: 'cash_on_hand', pos_terminal: 'provider_clearing' } as const;

export async function addPayrollEntry(access: TenantAccess, actor: AuditActor, input: z.infer<typeof payrollEntryInput>) {
  const tz = access.timezone;
  const effectiveOn = input.effective_on ?? DateTime.now().setZone(tz).toISODate()!;
  if (!DateTime.fromISO(effectiveOn).isValid) throw Errors.invalid('invalid_date');
  if (input.kind === 'tip' && !input.method) throw Errors.invalid('tip_method_required', 'Choose how the tip was paid');
  if (input.kind !== 'tip' && input.booking_id) throw Errors.invalid('booking_only_for_tips');
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
      effective_on: effectiveOn, note: input.note || null, booking_id: input.kind === 'tip' ? input.booking_id ?? null : null,
      method: input.kind === 'tip' ? input.method! : null, created_by: actor.userId,
    }).returningAll().executeTakeFirstOrThrow();
    if (e.kind === 'tip') {
      await post(trx, access.tenantId, { type: 'payroll_tip', id: e.id }, [{ account: TIP_ACCOUNT[e.method as 'cash' | 'pos_terminal'], debit: e.amount_minor }, { account: 'tips_payable', credit: e.amount_minor }],
        { createdBy: actor.userId, memo: `tip ${staff.display_name}` });
    } else if (e.kind === 'advance') {
      await post(trx, access.tenantId, { type: 'payroll_advance', id: e.id }, [{ account: 'staff_advances', debit: e.amount_minor }, { account: 'cash_on_hand', credit: e.amount_minor }],
        { createdBy: actor.userId, memo: `advance ${staff.display_name}` });
    }
    await audit(trx, actor, `payroll.${e.kind}_recorded`, { tenantId: access.tenantId, targetType: 'payroll_entry', targetId: e.id, data: { staff_id: e.staff_id, amount_minor: e.amount_minor, effective_on: e.effective_on, booking_id: e.booking_id } });
    return e;
  });
}

export async function voidPayrollEntry(access: TenantAccess, actor: AuditActor, id: string, reason: string) {
  return withTenant(access.tenantId, async (trx) => {
    const e = await trx.selectFrom('payroll_entries').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
    if (!e) throw Errors.notFound('payroll_entry');
    if (e.voided_at) throw Errors.conflict('already_void');
    if (await trx.selectFrom('payroll_settled_items').select('source_id').where('source_type', '=', 'entry').where('source_id', '=', id).executeTakeFirst()) {
      throw Errors.conflict('payroll_entry_settled', 'This entry is part of a closed month');
    }
    await trx.updateTable('payroll_entries').set({ voided_at: new Date(), voided_by: actor.userId, void_reason: reason }).where('id', '=', id).execute();
    const refType = e.kind === 'tip' ? 'payroll_tip' : e.kind === 'advance' ? 'payroll_advance' : null;
    if (refType) {
      const orig = await trx.selectFrom('financial_entries').select('entry_group_id').where('ref_type', '=', refType).where('ref_id', '=', id).executeTakeFirst();
      const lines: Line[] = e.kind === 'tip'
        ? [{ account: 'tips_payable', debit: e.amount_minor }, { account: TIP_ACCOUNT[e.method as 'cash' | 'pos_terminal'], credit: e.amount_minor }]
        : [{ account: 'cash_on_hand', debit: e.amount_minor }, { account: 'staff_advances', credit: e.amount_minor }];
      await post(trx, access.tenantId, { type: `${refType}_void`, id }, lines, { createdBy: actor.userId, reversesGroupId: orig?.entry_group_id ?? null, memo: reason });
    }
    await audit(trx, actor, 'payroll.entry_voided', { tenantId: access.tenantId, targetType: 'payroll_entry', targetId: id, data: { reason, kind: e.kind } });
    return { id, voided: true };
  });
}

export async function listPayrollEntries(access: TenantAccess, month: string) {
  requireMonth(month);
  const start = `${month}-01`;
  const end = DateTime.fromISO(start).endOf('month').toISODate()!;
  return withTenant(access.tenantId, (trx) => trx.selectFrom('payroll_entries as p').innerJoin('staff_profiles as sp', 'sp.id', 'p.staff_id')
    .leftJoin('bookings as b', 'b.id', 'p.booking_id')
    .leftJoin('payroll_settled_items as s', (j) => j.onRef('s.source_id', '=', 'p.id').on('s.source_type', '=', 'entry'))
    .leftJoin('payroll_runs as r', 'r.id', 's.run_id')
    .select(['p.id', 'p.staff_id', 'sp.display_name as staff_name', 'p.kind', 'p.amount_minor', 'p.effective_on', 'p.note', 'p.method', 'p.booking_id', 'b.number as booking_number',
      'p.voided_at', 'p.void_reason', 'p.created_at', 'r.period_month as settled_in'])
    .where('p.effective_on', '>=', start).where('p.effective_on', '<=', end)
    .orderBy('p.effective_on', 'desc').orderBy('p.created_at', 'desc').limit(500).execute()
    .then((rows) => rows.map((r) => ({ ...r, settled_in: r.settled_in ? monthOf(r.settled_in) : null }))));
}

// ── Base salaries ───────────────────────────────────────────────────────────
export const baseSalaryInput = z.object({ base_salary_minor: z.number().int().min(0).max(MAX_MINOR) }).strict();

export async function listPayProfiles(access: TenantAccess) {
  return withTenant(access.tenantId, (trx) => trx.selectFrom('staff_profiles as sp').leftJoin('staff_pay_profiles as pp', 'pp.staff_id', 'sp.id')
    .select(['sp.id as staff_id', 'sp.display_name', 'sp.title_ar', 'sp.title_en', 'sp.is_active', sql<number>`coalesce(pp.base_salary_minor, 0)::bigint`.as('base_salary_minor'), 'pp.updated_at'])
    .where('sp.archived_at', 'is', null).orderBy('sp.sort').orderBy('sp.display_name').execute());
}

export async function setBaseSalary(access: TenantAccess, actor: AuditActor, staffId: string, input: z.infer<typeof baseSalaryInput>) {
  return withTenant(access.tenantId, async (trx) => {
    const staff = await trx.selectFrom('staff_profiles').select('id').where('id', '=', staffId).where('archived_at', 'is', null).executeTakeFirst();
    if (!staff) throw Errors.notFound('staff');
    const before = await trx.selectFrom('staff_pay_profiles').select('base_salary_minor').where('staff_id', '=', staffId).executeTakeFirst();
    await trx.insertInto('staff_pay_profiles').values({ tenant_id: access.tenantId, staff_id: staffId, base_salary_minor: input.base_salary_minor, updated_by: actor.userId })
      .onConflict((oc) => oc.columns(['tenant_id', 'staff_id']).doUpdateSet({ base_salary_minor: input.base_salary_minor, updated_by: actor.userId })).execute();
    await audit(trx, actor, 'payroll.base_salary_set', { tenantId: access.tenantId, targetType: 'staff', targetId: staffId, data: { from: before?.base_salary_minor ?? 0, to: input.base_salary_minor } });
    return { staff_id: staffId, base_salary_minor: input.base_salary_minor };
  });
}

// ── Service commission policy ───────────────────────────────────────────────
export const commissionPolicyInput = z.object({
  service_commission_enabled: z.boolean().optional(),
  tips_enabled: z.boolean().optional(),
  /** Business-wide default percentage (basis points) for services without their own rate; null removes it. */
  default_rate_bp: z.number().int().min(0).max(10000).nullable().optional(),
}).strict();

export const serviceCommissionInput = z.object({
  commission_enabled: z.boolean(),
  /** Percentage in basis points (1500 = 15%); null = no service-specific rate (the default rate applies). */
  rate_bp: z.number().int().min(0).max(10000).nullable(),
}).strict();

type RuleRow = { id: string; kind: string; rate_bp: number | null; amount_minor: number | null; staff_id: string | null; service_id: string | null };

async function currentRules(trx: Tx, today: string) {
  return trx.selectFrom('commission_rules').select(['id', 'kind', 'rate_bp', 'amount_minor', 'staff_id', 'service_id', 'effective_from'])
    .where('is_active', '=', true).where('effective_from', '<=', today)
    .where((eb) => eb.or([eb('effective_to', 'is', null), eb('effective_to', '>=', today)]))
    .orderBy('effective_from', 'desc').orderBy('created_at', 'desc').execute();
}

/**
 * Replaces the active percentage rule for one scope (business default when
 * serviceId is null). Old rules are deactivated, never edited, so every
 * commission entry keeps the rule it was earned under.
 */
async function replaceScopeRule(trx: Tx, access: TenantAccess, actor: AuditActor, serviceId: string | null, rateBp: number | null, current: RuleRow | undefined) {
  if (current && current.kind === 'percent' && current.rate_bp === rateBp) return current.id;
  if (!current && rateBp === null) return null;
  const today = DateTime.now().setZone(access.timezone).toISODate()!;
  let q = trx.updateTable('commission_rules').set({ is_active: false, effective_to: today }).where('is_active', '=', true).where('staff_id', 'is', null);
  q = serviceId ? q.where('service_id', '=', serviceId) : q.where('service_id', 'is', null);
  await q.execute();
  if (rateBp === null) return null;
  const r = await trx.insertInto('commission_rules').values({
    tenant_id: access.tenantId, staff_id: null, service_id: serviceId, kind: 'percent', rate_bp: rateBp, effective_from: today, created_by: actor.userId,
  }).returning('id').executeTakeFirstOrThrow();
  return r.id;
}

export async function getCommissionPolicy(access: TenantAccess) {
  const today = DateTime.now().setZone(access.timezone).toISODate()!;
  return withTenant(access.tenantId, async (trx) => {
    const st = await trx.selectFrom('tenant_settings').select(['service_commission_enabled', 'tips_enabled']).where('tenant_id', '=', access.tenantId).executeTakeFirst();
    const rules = await currentRules(trx, today);
    const services = await trx.selectFrom('services as s').leftJoin('service_commission_settings as c', 'c.service_id', 's.id')
      .select(['s.id', 's.name_ar', 's.name_en', 's.price_minor', 's.is_active', sql<boolean>`coalesce(c.commission_enabled, true)`.as('commission_enabled')])
      .where('s.archived_at', 'is', null).orderBy('s.sort').orderBy('s.name_ar').execute();
    const pick = (r?: RuleRow) => (r ? { id: r.id, kind: r.kind, rate_bp: r.rate_bp, amount_minor: r.amount_minor } : null);
    return {
      service_commission_enabled: st?.service_commission_enabled ?? true,
      tips_enabled: st?.tips_enabled ?? true,
      products_earn_commission: false,
      default_rule: pick(rules.find((r) => !r.staff_id && !r.service_id)),
      staff_rules: rules.filter((r) => r.staff_id).length,
      services: services.map((s) => ({
        ...s,
        rule: pick(rules.find((r) => !r.staff_id && r.service_id === s.id)),
        staff_overrides: rules.filter((r) => r.staff_id && r.service_id === s.id).length,
      })),
    };
  });
}

export async function updateCommissionPolicy(access: TenantAccess, actor: AuditActor, input: z.infer<typeof commissionPolicyInput>) {
  const today = DateTime.now().setZone(access.timezone).toISODate()!;
  await withTenant(access.tenantId, async (trx) => {
    const patch: { service_commission_enabled?: boolean; tips_enabled?: boolean } = {};
    if (input.service_commission_enabled !== undefined) patch.service_commission_enabled = input.service_commission_enabled;
    if (input.tips_enabled !== undefined) patch.tips_enabled = input.tips_enabled;
    if (Object.keys(patch).length) await trx.updateTable('tenant_settings').set(patch).where('tenant_id', '=', access.tenantId).execute();
    if (input.default_rate_bp !== undefined) {
      const current = (await currentRules(trx, today)).find((r) => !r.staff_id && !r.service_id);
      await replaceScopeRule(trx, access, actor, null, input.default_rate_bp, current);
    }
    await audit(trx, actor, 'payroll.commission_policy_updated', { tenantId: access.tenantId, targetType: 'tenant', targetId: access.tenantId, data: input });
  });
  return getCommissionPolicy(access);
}

export async function setServiceCommission(access: TenantAccess, actor: AuditActor, serviceId: string, input: z.infer<typeof serviceCommissionInput>) {
  const today = DateTime.now().setZone(access.timezone).toISODate()!;
  return withTenant(access.tenantId, async (trx) => {
    const svc = await trx.selectFrom('services').select('id').where('id', '=', serviceId).where('archived_at', 'is', null).executeTakeFirst();
    if (!svc) throw Errors.notFound('service');
    await trx.insertInto('service_commission_settings').values({ tenant_id: access.tenantId, service_id: serviceId, commission_enabled: input.commission_enabled, updated_by: actor.userId })
      .onConflict((oc) => oc.columns(['tenant_id', 'service_id']).doUpdateSet({ commission_enabled: input.commission_enabled, updated_by: actor.userId })).execute();
    const current = (await currentRules(trx, today)).find((r) => !r.staff_id && r.service_id === serviceId);
    const ruleId = await replaceScopeRule(trx, access, actor, serviceId, input.rate_bp, current);
    await audit(trx, actor, 'payroll.service_commission_set', { tenantId: access.tenantId, targetType: 'service', targetId: serviceId, data: input });
    return { service_id: serviceId, commission_enabled: input.commission_enabled, rate_bp: input.rate_bp, rule_id: ruleId };
  });
}

/**
 * Commission gate used when commissions are earned: the business switch and
 * the per-service switch. Returns the set of service ids that must not earn.
 */
export async function commissionGate(trx: Tx, tenantId: string) {
  const st = await trx.selectFrom('tenant_settings').select('service_commission_enabled').where('tenant_id', '=', tenantId).executeTakeFirst();
  if (st && !st.service_commission_enabled) return { enabled: false as const, excluded: new Set<string>() };
  const off = await trx.selectFrom('service_commission_settings').select('service_id').where('commission_enabled', '=', false).execute();
  return { enabled: true as const, excluded: new Set(off.map((r) => r.service_id)) };
}
