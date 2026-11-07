import { DateTime } from 'luxon';
import { sql } from 'kysely';
import { z } from 'zod';
import { withTenant, type Tx } from '../../db/client';
import { Errors } from '../../http/errors';
import { audit, type AuditActor } from '../../infra/audit';
import { notifyStaff } from '../../infra/notify';
import { hasCapability, type TenantAccess } from '../../tenancy/access';
import { loadHrSettings, loadPay, todayIn } from './common';
import { accruedLeaveDays, round2, yearlyEntitlement } from './rules';

export type LeaveBalance = {
  staff_id: string;
  hire_date: string | null;
  as_of: string;
  yearly_entitlement: number;
  accrued: number;
  adjustments: number;
  taken: number;
  /** Annual days in requests still pending approval. */
  pending: number;
  /** null when the hire date is unknown (no balance can be computed or enforced). */
  balance: number | null;
  /** Sick days taken in the current calendar year (tracked separately; never consumes annual). */
  sick_taken_year: number;
};

/** Annual leave balance per staff member at a date: accrued + adjustments − taken. */
export async function balancesAt(trx: Tx, staffIds: string[], asOf: string): Promise<Map<string, LeaveBalance>> {
  const out = new Map<string, LeaveBalance>();
  if (!staffIds.length) return out;
  const pay = await loadPay(trx, staffIds);
  const yearStart = `${asOf.slice(0, 4)}-01-01`;
  const ledger = await trx.selectFrom('leave_ledger').select(['staff_id', 'bucket', 'kind', 'days', 'created_at']).where('staff_id', 'in', staffIds).execute();
  const pending = await trx.selectFrom('hr_requests as r').innerJoin('hr_request_types as t', 't.id', 'r.type_id')
    .select(['r.staff_id', sql<number>`coalesce(sum(r.leave_days), 0)::float8`.as('days')])
    .where('r.staff_id', 'in', staffIds).where('r.status', '=', 'pending').where('t.leave_type', '=', 'annual').groupBy('r.staff_id').execute();
  for (const id of staffIds) {
    const hire = pay.get(id)?.hire ?? null;
    const rows = ledger.filter((l) => l.staff_id === id);
    const annual = rows.filter((l) => l.bucket === 'annual');
    const adjustments = round2(annual.filter((l) => l.kind === 'adjustment').reduce((a, l) => a + Number(l.days), 0));
    const taken = round2(-annual.filter((l) => l.kind === 'taken').reduce((a, l) => a + Number(l.days), 0));
    const sick = round2(-rows.filter((l) => l.bucket === 'sick' && l.kind === 'taken' && DateTime.fromJSDate(l.created_at).toISODate()! >= yearStart).reduce((a, l) => a + Number(l.days), 0));
    const accrued = hire ? accruedLeaveDays(hire, asOf) : 0;
    out.set(id, {
      staff_id: id, hire_date: hire, as_of: asOf, yearly_entitlement: yearlyEntitlement(hire, asOf),
      accrued, adjustments, taken, pending: round2(Number(pending.find((p) => p.staff_id === id)?.days ?? 0)),
      balance: hire ? round2(accrued + adjustments - taken) : null, sick_taken_year: sick,
    });
  }
  return out;
}

/**
 * Checks an annual leave request against the balance projected at its start
 * date, less other pending annual requests. Returns whether it is short;
 * throws when the business blocks insufficient balances.
 */
export async function checkAnnualBalance(trx: Tx, staffId: string, startsOn: string, days: number, opts: { excludePendingDays?: number } = {}) {
  const b = (await balancesAt(trx, [staffId], startsOn)).get(staffId)!;
  if (b.balance == null) return { short: false, balance: b };
  const available = round2(b.balance - Math.max(0, b.pending - (opts.excludePendingDays ?? 0)));
  if (days <= available) return { short: false, balance: b };
  const settings = await loadHrSettings(trx);
  if (settings.leave_balance_policy === 'block') {
    throw Errors.invalid('leave_balance_insufficient', 'Not enough annual leave balance', { available, requested: days });
  }
  return { short: true, balance: b, available };
}

/** Balances: everyone for approvers/HR managers, otherwise only the caller's own. */
export async function listBalances(access: TenantAccess, staffId?: string) {
  const all = hasCapability(access, ['leave.approve', 'schedule.manage', 'hr.configure']);
  if (staffId && staffId !== access.staffProfileId && !all) throw Errors.notFound('staff');
  if (!staffId && !all && !access.staffProfileId) return [];
  return withTenant(access.tenantId, async (trx) => {
    let q = trx.selectFrom('staff_profiles').select(['id', 'display_name']).where('archived_at', 'is', null);
    if (staffId) q = q.where('id', '=', staffId);
    else if (!all) q = q.where('id', '=', access.staffProfileId!);
    const staff = await q.orderBy('sort').execute();
    const bal = await balancesAt(trx, staff.map((s) => s.id), todayIn(access.timezone));
    return staff.map((s) => ({ ...bal.get(s.id)!, staff_name: s.display_name }));
  });
}

export const balanceAdjustInput = z.object({
  days: z.number().min(-365).max(365).refine((v) => v !== 0 && Math.round(v * 100) === v * 100, 'Use up to two decimals'),
  note: z.string().trim().min(3).max(500),
}).strict();

/** Owner (hr.configure) adjusts a staff member's annual balance; recorded in the append-only ledger. */
export async function adjustBalance(access: TenantAccess, actor: AuditActor, staffId: string, input: z.infer<typeof balanceAdjustInput>) {
  return withTenant(access.tenantId, async (trx) => {
    const s = await trx.selectFrom('staff_profiles').select(['id']).where('id', '=', staffId).where('archived_at', 'is', null).executeTakeFirst();
    if (!s) throw Errors.notFound('staff');
    const row = await trx.insertInto('leave_ledger').values({
      tenant_id: access.tenantId, staff_id: staffId, bucket: 'annual', kind: 'adjustment', days: input.days, note: input.note, created_by: actor.userId,
    }).returning(['id', 'created_at']).executeTakeFirstOrThrow();
    await audit(trx, actor, 'hr.leave_balance_adjusted', { tenantId: access.tenantId, targetType: 'staff', targetId: staffId, data: { days: input.days, note: input.note } });
    await notifyStaff(trx, access.tenantId, staffId, {
      kind: 'hr.leave_balance_adjusted', title_ar: 'تم تعديل رصيد إجازتك', title_en: 'Your leave balance was adjusted', target_path: `/app/${access.slug}/me`,
    });
    const bal = (await balancesAt(trx, [staffId], todayIn(access.timezone))).get(staffId)!;
    return { id: row.id, ...bal };
  });
}

/** Ledger history of one staff member (adjustments and days taken). */
export async function balanceHistory(access: TenantAccess, staffId: string) {
  const all = hasCapability(access, ['leave.approve', 'schedule.manage', 'hr.configure']);
  if (staffId !== access.staffProfileId && !all) throw Errors.notFound('staff');
  return withTenant(access.tenantId, (trx) => trx.selectFrom('leave_ledger').select(['id', 'bucket', 'kind', 'days', 'note', 'leave_request_id', 'created_at'])
    .where('staff_id', '=', staffId).orderBy('created_at', 'desc').limit(200).execute());
}
