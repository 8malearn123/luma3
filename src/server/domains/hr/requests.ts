import { randomBytes } from 'node:crypto';
import { DateTime } from 'luxon';
import { sql } from 'kysely';
import { z } from 'zod';
import { withTenant, type Tx } from '../../db/client';
import { Errors } from '../../http/errors';
import { audit, type AuditActor } from '../../infra/audit';
import { notifyCapability, notifyStaff } from '../../infra/notify';
import { hasCapability, type TenantAccess } from '../../tenancy/access';
import { recordPayrollEntry } from '../payroll/service';
import { futureBookingsFor } from '../team/service';
import { checkAnnualBalance } from './balance';
import { CHAIN_ROLES, DATE_RE, loadSchedules, notifyRoles } from './common';
import { createUnpaidLeaveSuggestions } from './deductions';
import { datesBetween, leaveDayCount, localDatesOf } from './rules';

/**
 * Staff requests with approval chains.
 *
 * Each request type (seeded per business, plus custom ones) has an ordered
 * chain of roles. A request starts at step 0; a member holding that step's
 * role approves (moving it to the next step) or rejects it, with a note. The
 * owner may act at any step, and her approval is final. Staff can cancel a
 * request while it is pending. Every action is kept in hr_request_actions.
 *
 * Leave requests also create a row in leave_requests (status `requested`) so
 * the existing leave list and availability keep working; the final approval
 * approves that row, consumes the balance (annual/sick), suggests the unpaid
 * leave deduction, and lists the affected bookings for rerouting. An approved
 * advance request becomes a payroll advance.
 */

export type LeaveKind = 'annual' | 'sick' | 'emergency' | 'unpaid';
export type FieldDef = { key: string; label_ar: string; label_en?: string; type: 'text' | 'number' | 'date' | 'select'; required: boolean; options?: string[] };

const SEED: Array<{ code: string; kind: 'leave' | 'advance' | 'letter'; leave_type: LeaveKind | null; name_ar: string; name_en: string; chain: string[]; fields: FieldDef[] }> = [
  { code: 'annual_leave', kind: 'leave', leave_type: 'annual', name_ar: 'إجازة سنوية', name_en: 'Annual leave', chain: ['manager', 'owner'], fields: [] },
  { code: 'sick_leave', kind: 'leave', leave_type: 'sick', name_ar: 'إجازة مرضية', name_en: 'Sick leave', chain: ['manager', 'owner'], fields: [] },
  { code: 'emergency_leave', kind: 'leave', leave_type: 'emergency', name_ar: 'إجازة اضطرارية', name_en: 'Emergency leave', chain: ['manager', 'owner'], fields: [] },
  { code: 'unpaid_leave', kind: 'leave', leave_type: 'unpaid', name_ar: 'إجازة بدون راتب', name_en: 'Unpaid leave', chain: ['manager', 'owner'], fields: [] },
  { code: 'advance', kind: 'advance', leave_type: null, name_ar: 'طلب سلفة', name_en: 'Advance request', chain: ['owner'], fields: [] },
  {
    code: 'salary_certificate', kind: 'letter', leave_type: null, name_ar: 'خطاب تعريف بالراتب', name_en: 'Salary certificate letter', chain: ['owner'],
    fields: [{ key: 'addressed_to', label_ar: 'الجهة الموجّه لها', label_en: 'Addressed to', type: 'text', required: false }],
  },
  { code: 'experience_letter', kind: 'letter', leave_type: null, name_ar: 'شهادة خبرة', name_en: 'Experience letter', chain: ['owner'], fields: [] },
];

/** Leave type of leave_requests that each seeded leave request type maps to. */
const LEGACY_TYPE_CODE: Record<string, string> = { annual: 'annual_leave', sick: 'sick_leave', emergency: 'emergency_leave', unpaid: 'unpaid_leave' };

export async function ensureRequestTypes(trx: Tx, tenantId: string) {
  const has = await trx.selectFrom('hr_request_types').select('id').limit(1).executeTakeFirst();
  if (has) return;
  await trx.insertInto('hr_request_types').values(SEED.map((s, i) => ({
    tenant_id: tenantId, code: s.code, kind: s.kind, leave_type: s.leave_type, name_ar: s.name_ar, name_en: s.name_en,
    approval_chain: JSON.stringify(s.chain), fields: JSON.stringify(s.fields), is_system: true, sort: i,
  }))).onConflict((oc) => oc.columns(['tenant_id', 'code']).doNothing()).execute();
}

// ── Request types ───────────────────────────────────────────────────────────
const fieldSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,29}$/),
  label_ar: z.string().trim().min(1).max(80),
  label_en: z.string().trim().max(80).optional(),
  type: z.enum(['text', 'number', 'date', 'select']),
  required: z.boolean().default(false),
  options: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
}).strict().refine((f) => f.type !== 'select' || (f.options?.length ?? 0) > 0, { message: 'A list needs options', path: ['options'] });

const chainSchema = z.array(z.enum(CHAIN_ROLES)).min(1).max(5);
const fieldsSchema = z.array(fieldSchema).max(15).refine((fs) => new Set(fs.map((f) => f.key)).size === fs.length, 'Field keys must be unique');

export const requestTypeInput = z.object({
  name_ar: z.string().trim().min(1).max(80),
  name_en: z.string().trim().max(80).nullable().optional(),
  kind: z.enum(['leave', 'letter', 'other']).default('other'),
  leave_type: z.enum(['annual', 'sick', 'emergency', 'unpaid']).optional(),
  approval_chain: chainSchema,
  fields: fieldsSchema.default([]),
}).strict().refine((v) => (v.kind === 'leave') === !!v.leave_type, { message: 'A leave type needs its balance kind', path: ['leave_type'] });

export const requestTypePatch = z.object({
  name_ar: z.string().trim().min(1).max(80).optional(),
  name_en: z.string().trim().max(80).nullable().optional(),
  approval_chain: chainSchema.optional(),
  fields: fieldsSchema.optional(),
  is_active: z.boolean().optional(),
  sort: z.number().int().min(0).max(1000).optional(),
}).strict();

export async function listRequestTypes(access: TenantAccess, opts: { includeInactive?: boolean } = {}) {
  return withTenant(access.tenantId, async (trx) => {
    await ensureRequestTypes(trx, access.tenantId);
    let q = trx.selectFrom('hr_request_types').selectAll();
    if (!opts.includeInactive || !hasCapability(access, 'hr.configure')) q = q.where('is_active', '=', true);
    return q.orderBy('sort').orderBy('created_at').execute();
  });
}

export async function createRequestType(access: TenantAccess, actor: AuditActor, input: z.infer<typeof requestTypeInput>) {
  return withTenant(access.tenantId, async (trx) => {
    await ensureRequestTypes(trx, access.tenantId);
    const max = await trx.selectFrom('hr_request_types').select(sql<number>`coalesce(max(sort), 0)::int`.as('m')).executeTakeFirstOrThrow();
    const r = await trx.insertInto('hr_request_types').values({
      tenant_id: access.tenantId, code: `custom_${randomBytes(5).toString('hex')}`, kind: input.kind, leave_type: input.kind === 'leave' ? input.leave_type! : null,
      name_ar: input.name_ar, name_en: input.name_en ?? null, approval_chain: JSON.stringify(input.approval_chain), fields: JSON.stringify(input.fields),
      sort: max.m + 1, updated_by: actor.userId,
    }).returningAll().executeTakeFirstOrThrow();
    await audit(trx, actor, 'hr.request_type_created', { tenantId: access.tenantId, targetType: 'hr_request_type', targetId: r.id, data: input });
    return r;
  });
}

export async function updateRequestType(access: TenantAccess, actor: AuditActor, id: string, patch: z.infer<typeof requestTypePatch>) {
  return withTenant(access.tenantId, async (trx) => {
    const cur = await trx.selectFrom('hr_request_types').select(['id']).where('id', '=', id).executeTakeFirst();
    if (!cur) throw Errors.notFound('request_type');
    const set: Record<string, unknown> = { updated_by: actor.userId };
    if (patch.name_ar !== undefined) set.name_ar = patch.name_ar;
    if (patch.name_en !== undefined) set.name_en = patch.name_en;
    if (patch.approval_chain) set.approval_chain = JSON.stringify(patch.approval_chain);
    if (patch.fields) set.fields = JSON.stringify(patch.fields);
    if (patch.is_active !== undefined) set.is_active = patch.is_active;
    if (patch.sort !== undefined) set.sort = patch.sort;
    const r = await trx.updateTable('hr_request_types').set(set).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
    await audit(trx, actor, 'hr.request_type_updated', { tenantId: access.tenantId, targetType: 'hr_request_type', targetId: id, data: patch });
    return r;
  });
}

// ── Submission ──────────────────────────────────────────────────────────────
export const submitRequestInput = z.object({
  type_id: z.string().uuid(),
  /** Managers with schedule.manage may submit on behalf of a staff member. */
  staff_id: z.string().uuid().optional(),
  starts_on: z.string().regex(DATE_RE).optional(),
  ends_on: z.string().regex(DATE_RE).optional(),
  amount_minor: z.number().int().positive().max(100_000_000_000).optional(),
  installments: z.number().int().min(1).max(36).optional(),
  values: z.record(z.string(), z.union([z.string().max(500), z.number()])).default({}),
  note: z.string().trim().max(1000).optional(),
}).strict();

function cleanValues(fields: FieldDef[], values: Record<string, string | number>) {
  const out: Record<string, string | number> = {};
  for (const f of fields) {
    const v = values[f.key];
    const empty = v === undefined || v === null || (typeof v === 'string' && !v.trim());
    if (empty) {
      if (f.required) throw Errors.invalid('request_field_required', `${f.label_en || f.label_ar} is required`, { field: f.key });
      continue;
    }
    if (f.type === 'number') {
      const n = typeof v === 'number' ? v : Number(v);
      if (!Number.isFinite(n)) throw Errors.invalid('request_field_invalid', 'Enter a number', { field: f.key });
      out[f.key] = n;
    } else if (f.type === 'date') {
      if (typeof v !== 'string' || !DATE_RE.test(v) || !DateTime.fromISO(v).isValid) throw Errors.invalid('request_field_invalid', 'Enter a date', { field: f.key });
      out[f.key] = v;
    } else if (f.type === 'select') {
      if (typeof v !== 'string' || !(f.options ?? []).includes(v)) throw Errors.invalid('request_field_invalid', 'Choose from the list', { field: f.key });
      out[f.key] = v;
    } else out[f.key] = String(v).trim().slice(0, 500);
  }
  return out;
}

/** Working days of a leave (see rules.leaveDayCount) for a staff member. */
export async function leaveDaysFor(trx: Tx, tz: string, staffId: string, dates: string[]) {
  if (!dates.length) return 0;
  const sched = (await loadSchedules(trx, [staffId], dates[0]!, dates[dates.length - 1]!))[staffId]!;
  return leaveDayCount(tz, sched, dates);
}

type TypeRow = { id: string; kind: string; leave_type: string | null; name_ar: string; name_en: string | null; approval_chain: unknown; fields: unknown; is_active: boolean };

async function insertRequest(trx: Tx, access: TenantAccess, actor: AuditActor, t: TypeRow, v: {
  staffId: string; startsOn?: string | null; endsOn?: string | null; days?: number | null; leaveRequestId?: string | null; balanceWarning?: boolean;
  amount?: number | null; installments?: number | null; values: Record<string, string | number>; note?: string | null;
}) {
  const chain = t.approval_chain as string[];
  const r = await trx.insertInto('hr_requests').values({
    tenant_id: access.tenantId, type_id: t.id, staff_id: v.staffId, approval_chain: JSON.stringify(chain), field_values: JSON.stringify(v.values),
    starts_on: v.startsOn ?? null, ends_on: v.endsOn ?? null, leave_days: v.days ?? null, leave_request_id: v.leaveRequestId ?? null,
    balance_warning: !!v.balanceWarning, amount_minor: v.amount ?? null, installments: v.installments ?? null, note: v.note ?? null, requested_by: actor.userId,
  }).returningAll().executeTakeFirstOrThrow();
  await trx.insertInto('hr_request_actions').values({ tenant_id: access.tenantId, request_id: r.id, step: 0, role: null, action: 'submitted', note: v.note ?? null, actor_user_id: actor.userId }).execute();
  await notifyRoles(trx, access.tenantId, [chain[0]!], {
    kind: 'hr.request_pending', title_ar: `طلب جديد بانتظار موافقتك: ${t.name_ar}`, title_en: `New request awaiting your approval: ${t.name_en || t.name_ar}`,
    target_path: `/app/${access.slug}/team?tab=requests&request=${r.id}`, data: { request_id: r.id },
  });
  await audit(trx, actor, 'hr.request_submitted', { tenantId: access.tenantId, targetType: 'hr_request', targetId: r.id, data: { type: t.id, staff_id: v.staffId, days: v.days ?? null, amount_minor: v.amount ?? null } });
  return r;
}

export async function submitRequest(access: TenantAccess, actor: AuditActor, input: z.infer<typeof submitRequestInput>) {
  const staffId = input.staff_id ?? access.staffProfileId;
  if (!staffId) throw Errors.invalid('staff_required', 'Your account is not linked to a staff profile');
  if (staffId !== access.staffProfileId && !hasCapability(access, 'schedule.manage')) throw Errors.notFound('staff');
  if (staffId === access.staffProfileId && !hasCapability(access, ['hr.request', 'schedule.manage'])) throw Errors.forbidden();
  const tz = access.timezone;
  return withTenant(access.tenantId, async (trx) => {
    await ensureRequestTypes(trx, access.tenantId);
    const t = await trx.selectFrom('hr_request_types').selectAll().where('id', '=', input.type_id).executeTakeFirst();
    if (!t || !t.is_active) throw Errors.notFound('request_type');
    const staff = await trx.selectFrom('staff_profiles').select(['id']).where('id', '=', staffId).where('archived_at', 'is', null).executeTakeFirst();
    if (!staff) throw Errors.notFound('staff');
    const values = cleanValues(t.fields as FieldDef[], input.values);
    if (t.kind === 'leave') {
      if (!input.starts_on || !input.ends_on) throw Errors.invalid('leave_dates_required', 'Choose the leave dates');
      if (input.ends_on < input.starts_on || !DateTime.fromISO(input.starts_on).isValid || !DateTime.fromISO(input.ends_on).isValid) throw Errors.invalid('invalid_range');
      const dates = datesBetween(input.starts_on, input.ends_on);
      if (dates.length > 366) throw Errors.invalid('range_too_long');
      const days = await leaveDaysFor(trx, tz, staffId, dates);
      if (days <= 0) throw Errors.invalid('leave_no_working_days', 'There are no working days in this period');
      let warn = false;
      if (t.leave_type === 'annual') warn = (await checkAnnualBalance(trx, staffId, input.starts_on, days)).short;
      const from = DateTime.fromISO(input.starts_on, { zone: tz }).startOf('day');
      const to = DateTime.fromISO(input.ends_on, { zone: tz }).plus({ days: 1 }).startOf('day');
      const lr = await trx.insertInto('leave_requests').values({
        tenant_id: access.tenantId, staff_id: staffId, during: `[${from.toUTC().toISO()},${to.toUTC().toISO()})`,
        leave_type: t.leave_type!, reason: input.note ?? null, requested_by: actor.userId,
      }).returning(['id']).executeTakeFirstOrThrow();
      const r = await insertRequest(trx, access, actor, t, { staffId, startsOn: input.starts_on, endsOn: input.ends_on, days, leaveRequestId: lr.id, balanceWarning: warn, values, note: input.note });
      return { ...r, warning: warn ? 'leave_balance_insufficient' : null };
    }
    if (t.kind === 'advance') {
      if (!input.amount_minor) throw Errors.invalid('advance_amount_required', 'Enter the amount');
      const n = input.installments ?? 1;
      if (input.amount_minor < n) throw Errors.invalid('advance_too_small_for_installments');
      return { ...(await insertRequest(trx, access, actor, t, { staffId, amount: input.amount_minor, installments: n, values, note: input.note })), warning: null };
    }
    return { ...(await insertRequest(trx, access, actor, t, { staffId, values, note: input.note })), warning: null };
  });
}

/**
 * A leave request made through the original leave endpoint joins the approval
 * chain of the matching seeded type (annual, sick, emergency, unpaid). Other
 * leave types keep the original single-step approval.
 */
export async function attachLeaveToChain(trx: Tx, access: TenantAccess, actor: AuditActor, leave: { id: string; staff_id: string; leave_type: string; from: Date; to: Date; reason: string | null }) {
  const code = LEGACY_TYPE_CODE[leave.leave_type];
  if (!code) return null;
  await ensureRequestTypes(trx, access.tenantId);
  const t = await trx.selectFrom('hr_request_types').selectAll().where('code', '=', code).where('is_active', '=', true).executeTakeFirst();
  if (!t) return null;
  const dates = localDatesOf(leave.from, leave.to, access.timezone);
  const days = await leaveDaysFor(trx, access.timezone, leave.staff_id, dates);
  let warn = false;
  if (t.leave_type === 'annual' && days > 0) warn = (await checkAnnualBalance(trx, leave.staff_id, dates[0]!, days)).short;
  return insertRequest(trx, access, actor, t, {
    staffId: leave.staff_id, startsOn: dates[0] ?? null, endsOn: dates[dates.length - 1] ?? null, days, leaveRequestId: leave.id, balanceWarning: warn, values: {}, note: leave.reason,
  });
}

// ── Decisions ───────────────────────────────────────────────────────────────
export const decideRequestInput = z.object({
  decision: z.enum(['approved', 'rejected']),
  note: z.string().trim().max(1000).optional(),
  /** Advance: the approver may change the instalments (and amount) before approving. */
  installments: z.number().int().min(1).max(36).optional(),
  amount_minor: z.number().int().positive().max(100_000_000_000).optional(),
  method: z.enum(['cash', 'bank_transfer']).optional(),
}).strict();

type ReqRow = { id: string; staff_id: string; status: string; current_step: number; approval_chain: unknown; requested_by: string | null };

/** Whether the caller can act on the request's current step. */
function canAct(access: TenantAccess, r: ReqRow) {
  if (r.status !== 'pending' || access.role === 'support') return false;
  if (access.role === 'owner') return true;
  const role = (r.approval_chain as string[])[r.current_step];
  return role === access.role && r.staff_id !== access.staffProfileId;
}

/** Whether the caller may see the request at all. */
function canSee(access: TenantAccess, r: ReqRow) {
  if (hasCapability(access, 'hr.configure') || access.role === 'owner') return true;
  if (access.staffProfileId && r.staff_id === access.staffProfileId) return true;
  return (r.approval_chain as string[]).includes(access.role);
}

export async function decideRequest(access: TenantAccess, actor: AuditActor, id: string, input: z.infer<typeof decideRequestInput>) {
  return withTenant(access.tenantId, async (trx) => {
    const r = await trx.selectFrom('hr_requests').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
    if (!r || !canSee(access, r)) throw Errors.notFound('request');
    if (r.status !== 'pending') throw Errors.conflict('already_decided', 'This request was already decided');
    if (!canAct(access, r)) throw Errors.forbidden('This step is for another role', { reason: 'not_your_step' });
    const t = await trx.selectFrom('hr_request_types').selectAll().where('id', '=', r.type_id).executeTakeFirstOrThrow();
    const chain = r.approval_chain as string[];
    const role = chain[r.current_step]!;
    const notifyTarget = `/app/${access.slug}/me`;

    if (input.decision === 'rejected') {
      await trx.updateTable('hr_requests').set({ status: 'rejected', decided_at: new Date() }).where('id', '=', id).execute();
      await trx.insertInto('hr_request_actions').values({ tenant_id: access.tenantId, request_id: id, step: r.current_step, role, action: 'rejected', note: input.note ?? null, actor_user_id: actor.userId }).execute();
      if (r.leave_request_id) {
        await trx.updateTable('leave_requests').set({ status: 'rejected', decided_by: actor.userId, decided_at: new Date(), decision_note: input.note ?? null }).where('id', '=', r.leave_request_id).execute();
      }
      await notifyStaff(trx, access.tenantId, r.staff_id, { kind: 'hr.request_rejected', title_ar: `تم رفض طلبك: ${t.name_ar}`, title_en: `Your request was declined: ${t.name_en || t.name_ar}`, target_path: notifyTarget, data: { request_id: id } });
      await audit(trx, actor, 'hr.request_rejected', { tenantId: access.tenantId, targetType: 'hr_request', targetId: id, data: { step: r.current_step, role } });
      return { id, status: 'rejected' as const, current_step: r.current_step, affected_booking_ids: [] as string[] };
    }

    // Approver edits to an advance before approving.
    let amount = r.amount_minor, installments = r.installments;
    const edits: Record<string, unknown> = {};
    if (t.kind === 'advance') {
      if (input.installments && input.installments !== installments) { edits.installments = { from: installments, to: input.installments }; installments = input.installments; }
      if (input.amount_minor && input.amount_minor !== amount) { edits.amount_minor = { from: amount, to: input.amount_minor }; amount = input.amount_minor; }
      if (amount && installments && amount < installments) throw Errors.invalid('advance_too_small_for_installments');
      if (Object.keys(edits).length) await trx.updateTable('hr_requests').set({ amount_minor: amount, installments }).where('id', '=', id).execute();
    }
    await trx.insertInto('hr_request_actions').values({
      tenant_id: access.tenantId, request_id: id, step: r.current_step, role, action: 'approved', note: input.note ?? null,
      data: JSON.stringify({ ...edits, ...(access.role === 'owner' && role !== 'owner' ? { by_owner: true } : {}) }), actor_user_id: actor.userId,
    }).execute();

    const last = r.current_step >= chain.length - 1;
    if (!last && access.role !== 'owner') {
      const next = r.current_step + 1;
      await trx.updateTable('hr_requests').set({ current_step: next }).where('id', '=', id).execute();
      await notifyRoles(trx, access.tenantId, [chain[next]!], {
        kind: 'hr.request_pending', title_ar: `طلب بانتظار موافقتك: ${t.name_ar}`, title_en: `Request awaiting your approval: ${t.name_en || t.name_ar}`,
        target_path: `/app/${access.slug}/team?tab=requests&request=${id}`, data: { request_id: id },
      });
      await audit(trx, actor, 'hr.request_step_approved', { tenantId: access.tenantId, targetType: 'hr_request', targetId: id, data: { step: r.current_step, role, edits } });
      return { id, status: 'pending' as const, current_step: next, affected_booking_ids: [] as string[] };
    }

    // Final approval.
    let affected: string[] = [];
    let entryId: string | null = null;
    if (t.kind === 'leave' && r.leave_request_id) {
      affected = await finalizeLeave(trx, access, actor, { requestId: id, leaveRequestId: r.leave_request_id, staffId: r.staff_id, leaveType: t.leave_type as LeaveKind, days: Number(r.leave_days ?? 0), startsOn: r.starts_on!, note: input.note ?? null });
    } else if (t.kind === 'advance' && amount) {
      const e = await recordPayrollEntry(trx, access, actor, {
        staff_id: r.staff_id, kind: 'advance', amount_minor: amount, installments: installments ?? 1, method: input.method ?? 'cash', note: `${t.name_ar}`,
      });
      entryId = e.id;
    }
    await trx.updateTable('hr_requests').set({ status: 'approved', decided_at: new Date(), current_step: chain.length - 1, payroll_entry_id: entryId }).where('id', '=', id).execute();
    await notifyStaff(trx, access.tenantId, r.staff_id, { kind: 'hr.request_approved', title_ar: `تمت الموافقة على طلبك: ${t.name_ar}`, title_en: `Your request was approved: ${t.name_en || t.name_ar}`, target_path: notifyTarget, data: { request_id: id } });
    await audit(trx, actor, 'hr.request_approved', { tenantId: access.tenantId, targetType: 'hr_request', targetId: id, data: { step: r.current_step, role, edits, payroll_entry_id: entryId, affected_bookings: affected.length } });
    return { id, status: 'approved' as const, current_step: chain.length - 1, affected_booking_ids: affected, payroll_entry_id: entryId };
  });
}

/**
 * Final approval of a leave: re-checks the annual balance, approves the
 * leave_requests row, records the days taken (annual/sick ledger), suggests
 * the unpaid-leave deduction, and alerts booking managers about affected
 * appointments (they reroute them from the leave list).
 */
async function finalizeLeave(trx: Tx, access: TenantAccess, actor: AuditActor, v: { requestId: string | null; leaveRequestId: string; staffId: string; leaveType: LeaveKind; days: number; startsOn: string; note: string | null }) {
  const lr = await trx.selectFrom('leave_requests').selectAll().select([sql<Date>`lower(during)`.as('from_at'), sql<Date>`upper(during)`.as('to_at')])
    .where('id', '=', v.leaveRequestId).forUpdate().executeTakeFirstOrThrow();
  if (lr.status !== 'requested') throw Errors.conflict('already_decided');
  if (v.leaveType === 'annual' && v.days > 0) await checkAnnualBalance(trx, v.staffId, v.startsOn, v.days, { excludePendingDays: v.requestId ? v.days : 0 });
  const affected = await futureBookingsFor(trx, v.staffId, { from: lr.from_at, to: lr.to_at });
  await trx.updateTable('leave_requests').set({ status: 'approved', decided_by: actor.userId, decided_at: new Date(), decision_note: v.note, affected_booking_ids: affected }).where('id', '=', lr.id).execute();
  if ((v.leaveType === 'annual' || v.leaveType === 'sick') && v.days > 0) {
    await trx.insertInto('leave_ledger').values({ tenant_id: access.tenantId, staff_id: v.staffId, bucket: v.leaveType, kind: 'taken', days: -v.days, leave_request_id: lr.id, created_by: actor.userId }).execute();
  }
  if (v.leaveType === 'unpaid') await createUnpaidLeaveSuggestions(trx, access, { staffId: v.staffId, leaveRequestId: lr.id, hrRequestId: v.requestId, from: lr.from_at, to: lr.to_at });
  if (affected.length) {
    await notifyCapability(trx, access.tenantId, ['bookings.manage'], {
      kind: 'leave.affects_bookings', title_ar: `إجازة معتمدة تتعارض مع ${affected.length} مواعيد — اقتراحات النقل جاهزة`, title_en: `Approved leave conflicts with ${affected.length} appointments — reassignment suggestions ready`,
      target_path: `/app/${access.slug}/team?tab=leave&reroute=${lr.id}`, data: { booking_ids: affected, leave_id: lr.id },
    });
  }
  await audit(trx, actor, 'leave.approved', { tenantId: access.tenantId, targetType: 'leave', targetId: lr.id, data: { affected_bookings: affected.length, days: v.days, via_request: v.requestId } });
  return affected;
}

export async function cancelRequest(access: TenantAccess, actor: AuditActor, id: string, note?: string) {
  return withTenant(access.tenantId, async (trx) => {
    const r = await trx.selectFrom('hr_requests').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
    const mine = !!r && ((!!access.staffProfileId && r.staff_id === access.staffProfileId) || r.requested_by === actor.userId);
    if (!r || !mine) throw Errors.notFound('request');
    if (r.status !== 'pending') throw Errors.conflict('request_not_pending', 'Only a pending request can be cancelled');
    await trx.updateTable('hr_requests').set({ status: 'cancelled', decided_at: new Date() }).where('id', '=', id).execute();
    await trx.insertInto('hr_request_actions').values({ tenant_id: access.tenantId, request_id: id, step: r.current_step, role: null, action: 'cancelled', note: note ?? null, actor_user_id: actor.userId }).execute();
    if (r.leave_request_id) await trx.updateTable('leave_requests').set({ status: 'cancelled' }).where('id', '=', r.leave_request_id).where('status', '=', 'requested').execute();
    await audit(trx, actor, 'hr.request_cancelled', { tenantId: access.tenantId, targetType: 'hr_request', targetId: id });
    return { id, status: 'cancelled' as const };
  });
}

/** The request linked to a leave_requests row (the original leave endpoints route decisions through it). */
export async function requestForLeave(access: TenantAccess, leaveId: string) {
  return withTenant(access.tenantId, (trx) => trx.selectFrom('hr_requests').select(['id', 'status']).where('leave_request_id', '=', leaveId).executeTakeFirst());
}

// ── Lists ───────────────────────────────────────────────────────────────────
export const listRequestsInput = z.object({
  scope: z.enum(['mine', 'inbox', 'all']).default('all'),
  status: z.enum(['pending', 'approved', 'rejected', 'cancelled']).optional(),
});

const baseSelect = (trx: Tx) => trx.selectFrom('hr_requests as r').innerJoin('hr_request_types as t', 't.id', 'r.type_id').innerJoin('staff_profiles as s', 's.id', 'r.staff_id')
  .select(['r.id', 'r.type_id', 'r.staff_id', 's.display_name as staff_name', 't.code as type_code', 't.kind', 't.leave_type', 't.name_ar as type_name_ar', 't.name_en as type_name_en',
    'r.status', 'r.current_step', 'r.approval_chain', 'r.field_values', 'r.starts_on', 'r.ends_on', 'r.leave_days', 'r.leave_request_id', 'r.balance_warning',
    'r.amount_minor', 'r.installments', 'r.payroll_entry_id', 'r.note', 'r.requested_by', 'r.decided_at', 'r.created_at']);

export async function listRequests(access: TenantAccess, f: z.infer<typeof listRequestsInput>) {
  return withTenant(access.tenantId, async (trx) => {
    let q = baseSelect(trx);
    const all = hasCapability(access, 'hr.configure') || access.role === 'owner';
    if (f.scope === 'mine') {
      if (!access.staffProfileId) return [];
      q = q.where('r.staff_id', '=', access.staffProfileId);
    } else if (!all) {
      q = q.where((w) => w.or([
        ...(access.staffProfileId ? [w('r.staff_id', '=', access.staffProfileId)] : []),
        sql<boolean>`r.approval_chain @> ${JSON.stringify([access.role])}::jsonb`,
      ]));
    }
    if (f.status) q = q.where('r.status', '=', f.status);
    else if (f.scope === 'inbox') q = q.where('r.status', '=', 'pending');
    const rows = (await q.orderBy('r.created_at', 'desc').limit(200).execute()).map((r) => ({ ...r, can_act: canAct(access, r), can_cancel: r.status === 'pending' && !!access.staffProfileId && r.staff_id === access.staffProfileId }));
    return f.scope === 'inbox' ? rows.filter((r) => r.can_act) : rows;
  });
}

export async function getRequest(access: TenantAccess, id: string) {
  return withTenant(access.tenantId, async (trx) => {
    const r = await baseSelect(trx).select(['t.fields']).where('r.id', '=', id).executeTakeFirst();
    if (!r || !canSee(access, r)) throw Errors.notFound('request');
    const actions = await trx.selectFrom('hr_request_actions as a').leftJoin('tenant_memberships as m', 'm.user_id', 'a.actor_user_id')
      .leftJoin('staff_profiles as sp', 'sp.id', 'm.staff_profile_id')
      .select(['a.id', 'a.step', 'a.role', 'a.action', 'a.note', 'a.data', 'a.created_at', 'm.role as actor_role', 'sp.display_name as actor_name'])
      .where('a.request_id', '=', id).orderBy('a.created_at').execute();
    return { ...r, can_act: canAct(access, r), can_cancel: r.status === 'pending' && !!access.staffProfileId && r.staff_id === access.staffProfileId, actions };
  });
}

/** Approves a leave that is not linked to a chain (original single-step path) — shared finalization. */
export async function finalizeLegacyLeave(trx: Tx, access: TenantAccess, actor: AuditActor, leave: { id: string; staff_id: string; leave_type: string; from: Date; to: Date }, note: string | null) {
  const dates = localDatesOf(leave.from, leave.to, access.timezone);
  const days = await leaveDaysFor(trx, access.timezone, leave.staff_id, dates);
  const kind = (['annual', 'sick', 'emergency', 'unpaid'] as const).find((k) => k === leave.leave_type) ?? 'emergency';
  return finalizeLeave(trx, access, actor, { requestId: null, leaveRequestId: leave.id, staffId: leave.staff_id, leaveType: kind, days, startsOn: dates[0] ?? DateTime.fromJSDate(leave.from).toISODate()!, note });
}
