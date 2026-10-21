import { sql } from 'kysely';
import type { z } from 'zod';
import { withTenant, type Tx } from '../../db/client';
import { Errors } from '../../http/errors';
import { audit, type AuditActor } from '../../infra/audit';
import { requireWithinLimit, type TenantAccess } from '../../tenancy/access';
import { recomputeOverage } from '../subscriptions/service';
import { normalizePhone } from '@/shared/phone';
import { overlappingRanges, type branchInput, type branchPatch } from '@/shared/schemas/settings';

/**
 * Branches: created within the plan's limit.branches (server-side), archived
 * rather than deleted (bookings keep pointing at them), one active primary.
 */
type Hours = Array<{ weekday: number; opens: string; closes: string }>;

function validateHours(hours: Hours) {
  for (const h of hours) if (h.closes <= h.opens) throw Errors.invalid('invalid_hours', 'Closing time must be after opening time');
  if (overlappingRanges(hours)) throw Errors.invalid('overlapping_hours', 'Opening ranges on the same day overlap');
}

async function setHours(trx: Tx, tenantId: string, branchId: string, hours: Hours) {
  validateHours(hours);
  await trx.deleteFrom('branch_hours').where('tenant_id', '=', tenantId).where('branch_id', '=', branchId).execute();
  if (hours.length) await trx.insertInto('branch_hours').values(hours.map((h) => ({ tenant_id: tenantId, branch_id: branchId, weekday: h.weekday, opens: h.opens, closes: h.closes }))).execute();
}

function phoneOrThrow(p: string | null | undefined) {
  if (!p) return null;
  const n = normalizePhone(p);
  if (!n) throw Errors.invalid('invalid_phone', 'Enter a valid phone number');
  return n;
}

async function activeCount(trx: Tx, tenantId: string) {
  const r = await trx.selectFrom('branches').select(sql<number>`count(*)::int`.as('n')).where('tenant_id', '=', tenantId).where('status', '=', 'active').executeTakeFirstOrThrow();
  return r.n;
}

async function refreshOverage(trx: Tx, tenantId: string) {
  const sub = await trx.selectFrom('subscriptions').select(['id', 'tenant_id', 'plan_id', 'overage_state']).where('tenant_id', '=', tenantId)
    .where('status', 'in', ['trialing', 'active', 'past_due', 'paused']).executeTakeFirst();
  if (sub) await recomputeOverage(trx, sub);
}

export async function listBranches(access: TenantAccess, includeArchived = true) {
  return withTenant(access.tenantId, async (trx) => {
    let q = trx.selectFrom('branches').selectAll().where('tenant_id', '=', access.tenantId);
    if (!includeArchived) q = q.where('status', '=', 'active');
    const rows = await q.orderBy('is_primary', 'desc').orderBy('created_at').execute();
    const hours = rows.length ? await trx.selectFrom('branch_hours').select(['branch_id', 'weekday', sql<string>`to_char(opens, 'HH24:MI')`.as('opens'), sql<string>`to_char(closes, 'HH24:MI')`.as('closes')])
      .where('tenant_id', '=', access.tenantId).orderBy('weekday').orderBy('opens').execute() : [];
    const limit = access.plan.features.get('limit.branches');
    return {
      items: rows.map((b) => ({ ...b, hours: hours.filter((h) => h.branch_id === b.id).map(({ weekday, opens, closes }) => ({ weekday, opens, closes })) })),
      limit: limit?.enabled ? limit.limit : 0,
      active: rows.filter((r) => r.status === 'active').length,
    };
  });
}

export async function createBranch(access: TenantAccess, actor: AuditActor, input: z.infer<typeof branchInput>) {
  return withTenant(access.tenantId, async (trx) => {
    // Serialise concurrent creations for this tenant so two requests cannot both pass the limit.
    await sql`select pg_advisory_xact_lock(hashtext(${`branches:${access.tenantId}`}))`.execute(trx);
    const n = await activeCount(trx, access.tenantId);
    requireWithinLimit(access, 'limit.branches', n);
    const row = await trx.insertInto('branches').values({
      tenant_id: access.tenantId, name: input.name, city: input.city ?? null, address: input.address ?? null,
      latitude: input.latitude ?? null, longitude: input.longitude ?? null, timezone: input.timezone, phone: phoneOrThrow(input.phone), is_primary: n === 0,
    }).returningAll().executeTakeFirstOrThrow();
    if (input.hours) await setHours(trx, access.tenantId, row.id, input.hours);
    await audit(trx, actor, 'branch.created', { tenantId: access.tenantId, targetType: 'branch', targetId: row.id, data: { name: input.name } });
    return row;
  });
}

export async function updateBranch(access: TenantAccess, actor: AuditActor, id: string, patch: z.infer<typeof branchPatch>) {
  return withTenant(access.tenantId, async (trx) => {
    await sql`select pg_advisory_xact_lock(hashtext(${`branches:${access.tenantId}`}))`.execute(trx);
    const cur = await trx.selectFrom('branches').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
    if (!cur) throw Errors.notFound('branch');
    if (cur.version !== patch.version) throw Errors.versionConflict(cur.version);
    const { version: _v, hours, is_primary, status, phone, ...fields } = patch;
    let futureBookings = 0;
    if (status === 'archived' && cur.status === 'active') {
      if (cur.is_primary) throw Errors.invalid('cannot_archive_primary', 'Choose another primary branch before archiving this one');
      const fb = await trx.selectFrom('bookings').select(sql<number>`count(*)::int`.as('n')).where('branch_id', '=', id)
        .where('starts_at', '>', new Date()).where('status', 'in', ['held', 'pending_approval', 'pending_payment', 'confirmed']).executeTakeFirstOrThrow();
      futureBookings = fb.n;
    }
    if (status === 'active' && cur.status === 'archived') requireWithinLimit(access, 'limit.branches', await activeCount(trx, access.tenantId));
    if (is_primary && !cur.is_primary) {
      if ((status ?? cur.status) !== 'active') throw Errors.invalid('primary_must_be_active', 'Only an active branch can be primary');
      await trx.updateTable('branches').set({ is_primary: false }).where('tenant_id', '=', access.tenantId).where('is_primary', '=', true).execute();
    }
    const row = await trx.updateTable('branches').set({
      ...fields,
      ...(phone !== undefined ? { phone: phoneOrThrow(phone) } : {}),
      ...(status ? { status } : {}),
      ...(is_primary ? { is_primary: true } : {}),
      version: cur.version + 1,
    }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
    if (hours) await setHours(trx, access.tenantId, id, hours);
    if (status && status !== cur.status) await refreshOverage(trx, access.tenantId);
    await audit(trx, actor, status === 'archived' && cur.status !== 'archived' ? 'branch.archived' : status === 'active' && cur.status === 'archived' ? 'branch.restored' : 'branch.updated',
      { tenantId: access.tenantId, targetType: 'branch', targetId: id, data: { fields: Object.keys(fields), hours: !!hours, primary: !!is_primary } });
    return { ...row, future_bookings: futureBookings };
  });
}
