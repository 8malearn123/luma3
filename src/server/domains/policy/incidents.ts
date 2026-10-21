import { sql } from 'kysely';
import type { z } from 'zod';
import { withTenant, type Tx } from '../../db/client';
import { Errors, isPgCode } from '../../http/errors';
import { audit, type AuditActor } from '../../infra/audit';
import { notifyCapability } from '../../infra/notify';
import type { TenantAccess } from '../../tenancy/access';
import { assetUrl } from '../assets/service';
import { INCIDENT_TRANSITIONS, type IncidentStatus, type incidentCreate, type incidentEscalate, type incidentEvidenceInput, type incidentListQuery, type incidentTransition } from '@/shared/schemas/policy';
import { likeTerm, offsetOf, page } from './paging';
import { suggestFor } from './rules';

/**
 * Incidents are business-internal records about booking terms and attendance.
 * They are reviewed by members holding incidents.review; confirming one only
 * produces rule SUGGESTIONS — it never changes the customer's terms, and it
 * never reaches LUMA unless the business explicitly escalates it.
 */

async function evidenceAssets(trx: Tx, tenantId: string, ids: string[]) {
  if (!ids.length) return;
  const rows = await trx.selectFrom('assets').select('id').where('tenant_id', '=', tenantId).where('id', 'in', [...new Set(ids)])
    .where('status', '=', 'ready').where('purpose', '=', 'evidence').execute();
  if (rows.length !== new Set(ids).size) throw Errors.invalid('invalid_evidence', 'Evidence files must be uploaded as private evidence for this business');
}

export async function createIncident(access: TenantAccess, actor: AuditActor, input: z.infer<typeof incidentCreate>, now = new Date()) {
  return withTenant(access.tenantId, async (trx) => {
    let tenantCustomerId = input.tenant_customer_id ?? null;
    let customerUserId: string | null = null;
    let bookingId: string | null = null;
    let occurredAt = input.occurred_at ?? null;

    if (input.booking_id) {
      // RLS + explicit tenant filter: another business's booking is simply "not found".
      const b = await trx.selectFrom('bookings').select(['id', 'status', 'starts_at', 'tenant_customer_id', 'customer_user_id', 'cancelled_at', 'cancel_source'])
        .where('tenant_id', '=', access.tenantId).where('id', '=', input.booking_id).executeTakeFirst();
      if (!b) throw Errors.notFound('booking');
      if (tenantCustomerId && tenantCustomerId !== b.tenant_customer_id) throw Errors.invalid('incident_customer_mismatch', 'The booking belongs to another customer');
      tenantCustomerId = b.tenant_customer_id;
      customerUserId = b.customer_user_id;
      bookingId = b.id;
      if (input.type === 'no_show') {
        if (b.status !== 'no_show') throw Errors.invalid('incident_booking_state', 'Mark the booking as a no-show before reporting it');
        const settings = await trx.selectFrom('tenant_settings').select('no_show_grace_min').where('tenant_id', '=', access.tenantId).executeTakeFirstOrThrow();
        const earliest = new Date(b.starts_at.getTime() + settings.no_show_grace_min * 60_000);
        if (now < earliest) throw Errors.invalid('incident_too_early', 'A no-show can only be reported after the appointment time and grace period', { earliest_at: earliest.toISOString() });
        occurredAt = occurredAt ?? b.starts_at;
      } else if (input.type === 'late_cancellation') {
        if (b.status !== 'cancelled' || b.cancel_source !== 'customer') throw Errors.invalid('incident_booking_state', 'Only a booking cancelled by the customer can be reported as a late cancellation');
        occurredAt = occurredAt ?? b.cancelled_at ?? b.starts_at;
      }
    } else if (input.type === 'no_show' || input.type === 'late_cancellation') {
      throw Errors.invalid('incident_booking_required', 'This type of incident must reference a real appointment');
    }
    const tc = await trx.selectFrom('tenant_customers').select(['id', 'user_id', 'display_name']).where('tenant_id', '=', access.tenantId).where('id', '=', tenantCustomerId!).executeTakeFirst();
    if (!tc) throw Errors.notFound('customer');
    customerUserId = customerUserId ?? tc.user_id;
    occurredAt = occurredAt ?? now;
    if (occurredAt.getTime() > now.getTime() + 60_000) throw Errors.invalid('incident_in_future', 'An incident cannot be in the future');

    await evidenceAssets(trx, access.tenantId, input.evidence.filter((e) => e.asset_id).map((e) => e.asset_id!));

    let row: Awaited<ReturnType<typeof insertIncident>>;
    try {
      row = await insertIncident(trx, { tenantId: access.tenantId, bookingId, tenantCustomerId: tc.id, customerUserId, type: input.type, description: input.description, occurredAt, submittedBy: actor.userId! });
    } catch (e) {
      if (isPgCode(e, '23505')) throw Errors.conflict('incident_duplicate', 'This appointment was already reported for the same reason');
      throw e;
    }
    if (input.evidence.length) {
      await trx.insertInto('incident_evidence').values(input.evidence.map((e) => ({
        tenant_id: access.tenantId, incident_id: row.id, asset_id: e.asset_id ?? null, note: e.note ?? null, added_by: actor.userId!,
      }))).execute();
    }
    await audit(trx, actor, 'incident.submitted', { tenantId: access.tenantId, targetType: 'incident', targetId: row.id, data: { type: input.type, booking_id: bookingId, evidence: input.evidence.length } });
    await notifyCapability(trx, access.tenantId, ['incidents.review'], {
      kind: 'incident.submitted', title_ar: 'بلاغ جديد بانتظار المراجعة', title_en: 'New incident awaiting review',
      target_path: `/app/${access.slug}/policies?incident=${row.id}`, dedupe_key: `incident.submitted:${row.id}`,
    });
    return row;
  });
}

async function insertIncident(trx: Tx, v: { tenantId: string; bookingId: string | null; tenantCustomerId: string; customerUserId: string | null; type: string; description: string; occurredAt: Date; submittedBy: string }) {
  await sql`savepoint incident_insert`.execute(trx);
  try {
    const row = await trx.insertInto('customer_incidents').values({
      tenant_id: v.tenantId, booking_id: v.bookingId, tenant_customer_id: v.tenantCustomerId, customer_user_id: v.customerUserId,
      type: v.type, description: v.description, occurred_at: v.occurredAt, submitted_by: v.submittedBy,
    }).returningAll().executeTakeFirstOrThrow();
    await sql`release savepoint incident_insert`.execute(trx);
    return row;
  } catch (e) {
    await sql`rollback to savepoint incident_insert`.execute(trx);
    throw e;
  }
}

/** Members with only incidents.submit see the reports they submitted themselves. */
export async function listIncidents(access: TenantAccess, q: z.infer<typeof incidentListQuery>, onlySubmittedBy?: string) {
  return withTenant(access.tenantId, async (trx) => {
    const offset = offsetOf(q.cursor);
    let query = trx.selectFrom('customer_incidents as i')
      .innerJoin('tenant_customers as c', (j) => j.onRef('c.id', '=', 'i.tenant_customer_id').onRef('c.tenant_id', '=', 'i.tenant_id'))
      .leftJoin('bookings as b', (j) => j.onRef('b.id', '=', 'i.booking_id').onRef('b.tenant_id', '=', 'i.tenant_id'))
      .select(['i.id', 'i.type', 'i.status', 'i.occurred_at', 'i.created_at', 'i.booking_id', 'i.tenant_customer_id', 'i.escalation_status', 'i.escalated_to_platform_at',
        'c.display_name as customer_name', 'b.number as booking_number', sql<string>`left(i.description, 160)`.as('summary')])
      .where('i.tenant_id', '=', access.tenantId);
    if (onlySubmittedBy) query = query.where('i.submitted_by', '=', onlySubmittedBy);
    if (q.status !== 'all') query = query.where('i.status', '=', q.status);
    if (q.type) query = query.where('i.type', '=', q.type);
    if (q.tenant_customer_id) query = query.where('i.tenant_customer_id', '=', q.tenant_customer_id);
    if (q.escalated === '1') query = query.where('i.escalation_status', 'is not', null);
    if (q.q) query = query.where((eb) => eb.or([eb('c.display_name', 'ilike', likeTerm(q.q!)), eb('b.number', 'ilike', likeTerm(q.q!))]));
    query = q.sort === 'occurred' ? query.orderBy('i.occurred_at', 'desc') : query.orderBy('i.created_at', 'desc');
    const rows = await query.orderBy('i.id').limit(q.limit + 1).offset(offset).execute();
    return page(rows, q.limit, offset);
  });
}

export async function getIncident(access: TenantAccess, id: string, onlySubmittedBy?: string) {
  return withTenant(access.tenantId, async (trx) => {
    const i = await trx.selectFrom('customer_incidents as i')
      .innerJoin('tenant_customers as c', (j) => j.onRef('c.id', '=', 'i.tenant_customer_id').onRef('c.tenant_id', '=', 'i.tenant_id'))
      .leftJoin('bookings as b', (j) => j.onRef('b.id', '=', 'i.booking_id').onRef('b.tenant_id', '=', 'i.tenant_id'))
      .leftJoin('users as s', 's.id', 'i.submitted_by')
      .selectAll('i')
      .select(['c.display_name as customer_name', 'b.number as booking_number', 'b.starts_at as booking_starts_at', 'b.status as booking_status', 's.display_name as submitted_by_name'])
      .where('i.tenant_id', '=', access.tenantId).where('i.id', '=', id).executeTakeFirst();
    if (!i || (onlySubmittedBy && i.submitted_by !== onlySubmittedBy)) throw Errors.notFound('incident');
    const [evidence, reviews, appeals] = await Promise.all([
      trx.selectFrom('incident_evidence').select(['id', 'asset_id', 'note', 'created_at', 'retain_until']).where('incident_id', '=', id).orderBy('created_at').execute(),
      trx.selectFrom('incident_reviews as r').leftJoin('users as u', 'u.id', 'r.reviewer_id')
        // Platform reviewers are never identified to the business.
        .select(['r.id', 'r.from_status', 'r.to_status', 'r.note', 'r.created_at', 'r.reviewer_scope', sql<string | null>`case when r.reviewer_scope = 'tenant' then u.display_name end`.as('reviewer_name')])
        .where('r.incident_id', '=', id).orderBy('r.created_at').execute(),
      trx.selectFrom('appeals').select(['id', 'status', 'created_at', 'resolved_at']).where('incident_id', '=', id).where('tenant_id', '=', access.tenantId).orderBy('created_at', 'desc').execute(),
    ]);
    // The platform reviewer's identity is never shown to the business.
    const { platform_reviewed_by: _pr, ...rest } = i;
    return {
      ...rest,
      evidence: evidence.map((e) => ({ ...e, url: e.asset_id ? assetUrl(e.asset_id) : null })),
      reviews, appeals,
      allowed_transitions: INCIDENT_TRANSITIONS[i.status as IncidentStatus] ?? [],
    };
  });
}

/** Reviewer transition with a mandatory note; history is append-only (incident_reviews). */
export async function transitionIncident(access: TenantAccess, actor: AuditActor, id: string, input: z.infer<typeof incidentTransition>) {
  return withTenant(access.tenantId, async (trx) => {
    const cur = await trx.selectFrom('customer_incidents').selectAll().where('tenant_id', '=', access.tenantId).where('id', '=', id).forUpdate().executeTakeFirst();
    if (!cur) throw Errors.notFound('incident');
    const from = cur.status as IncidentStatus;
    if (!INCIDENT_TRANSITIONS[from]?.includes(input.to)) throw Errors.conflict('invalid_transition', `Cannot move from ${from} to ${input.to}`, { from, to: input.to });
    // Four-eyes principle where a team exists; an owner (e.g. an independent expert) may review her own report.
    if (cur.submitted_by === actor.userId && access.role !== 'owner') throw Errors.forbidden('Another reviewer must review your own report', { reason: 'self_review' });
    if (input.corrected_description && input.to !== 'corrected') throw Errors.invalid('validation_failed', 'corrected_description is only for corrections');

    const updated = await trx.updateTable('customer_incidents').set({
      status: input.to,
      ...(input.corrected_description ? { description: input.corrected_description } : {}),
      // A rejected incident leaves the platform queue.
      ...(input.to === 'rejected' && cur.escalation_status === 'pending' ? { escalation_status: 'dismissed' } : {}),
    }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
    await trx.insertInto('incident_reviews').values({
      tenant_id: access.tenantId, incident_id: id, reviewer_id: actor.userId!, reviewer_scope: 'tenant', from_status: from, to_status: input.to, note: input.note,
    }).execute();
    await audit(trx, actor, `incident.${input.to}`, {
      tenantId: access.tenantId, targetType: 'incident', targetId: id,
      data: { from, to: input.to, ...(input.corrected_description ? { previous_description: cur.description } : {}) },
    });

    // Rules only suggest. Nothing about the customer's terms changes here.
    let suggestions: Awaited<ReturnType<typeof suggestFor>> = [];
    if (input.to === 'confirmed' || input.to === 'corrected') {
      suggestions = await suggestFor(trx, { scope: 'tenant', tenantId: access.tenantId, tenantCustomerId: cur.tenant_customer_id });
      if (suggestions.length) {
        await notifyCapability(trx, access.tenantId, ['incidents.review'], {
          kind: 'policy.suggestion', title_ar: 'اقتراح سياسة بانتظار قرار بشري', title_en: 'A policy suggestion awaits a human decision',
          target_path: `/app/${access.slug}/policies?customer=${cur.tenant_customer_id}`, dedupe_key: `policy.suggestion:${id}:${input.to}`,
        });
      }
    }
    // Overturning an incident revokes decisions that were based on it.
    if (input.to === 'rejected') await revokeDecisionsFromIncident(trx, access.tenantId, id, actor, 'incident rejected');
    return { ...updated, suggestions };
  });
}

export async function revokeDecisionsFromIncident(trx: Tx, tenantId: string, incidentId: string, actor: AuditActor, reason: string) {
  const rows = await trx.updateTable('policy_decisions').set({ status: 'revoked', ended_at: new Date(), ended_by: actor.userId, end_reason: reason })
    .where('tenant_id', '=', tenantId).where('scope', '=', 'tenant').where('source_incident_id', '=', incidentId).where('status', '=', 'active')
    .returning('id').execute();
  for (const r of rows) await audit(trx, actor, 'policy_decision.revoked', { tenantId, targetType: 'policy_decision', targetId: r.id, data: { reason, incident_id: incidentId } });
  return rows.length;
}

/** Explicit business action; a platform reviewer decides. Escalation creates no decision by itself. */
export async function escalateIncident(access: TenantAccess, actor: AuditActor, id: string, input: z.infer<typeof incidentEscalate>) {
  return withTenant(access.tenantId, async (trx) => {
    const cur = await trx.selectFrom('customer_incidents').selectAll().where('tenant_id', '=', access.tenantId).where('id', '=', id).forUpdate().executeTakeFirst();
    if (!cur) throw Errors.notFound('incident');
    if (cur.status !== 'confirmed' && cur.status !== 'corrected') throw Errors.conflict('incident_not_confirmed', 'Only a confirmed incident can be escalated');
    if (cur.escalation_status) throw Errors.conflict('already_escalated', 'This incident was already escalated');
    if (!cur.customer_user_id) throw Errors.invalid('incident_not_linked_to_account', 'This customer has no LUMA account; the incident stays within your business');
    const row = await trx.updateTable('customer_incidents').set({
      escalated_to_platform_at: new Date(), escalation_status: 'pending', escalated_by: actor.userId, escalation_note: input.note,
    }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
    await audit(trx, actor, 'incident.escalated', { tenantId: access.tenantId, targetType: 'incident', targetId: id });
    const reviewers = await trx.selectFrom('platform_roles').select('user_id').where('role', 'in', ['policy_reviewer', 'platform_owner']).where('revoked_at', 'is', null).execute();
    // Platform-level notification (tenant_id NULL). Inserted without ON CONFLICT:
    // under tenant RLS an upsert would also need SELECT visibility of NULL-tenant
    // rows, which the tenant scope (correctly) does not have. Escalation happens once.
    const uids = [...new Set(reviewers.map((r) => r.user_id))];
    if (uids.length) {
      await trx.insertInto('notifications').values(uids.map((u) => ({
        tenant_id: null, user_id: u, kind: 'policy.escalation', title_ar: 'بلاغ مُصعّد بانتظار مراجعة لوما', title_en: 'Escalated incident awaiting LUMA review',
        target_path: '/platform/policies', data: JSON.stringify({}),
      }))).execute();
    }
    return row;
  });
}

export async function addEvidence(access: TenantAccess, actor: AuditActor, id: string, input: z.infer<typeof incidentEvidenceInput>) {
  return withTenant(access.tenantId, async (trx) => {
    const cur = await trx.selectFrom('customer_incidents').select(['id', 'status']).where('tenant_id', '=', access.tenantId).where('id', '=', id).executeTakeFirst();
    if (!cur) throw Errors.notFound('incident');
    if (cur.status === 'rejected') throw Errors.conflict('incident_closed', 'This incident is closed');
    if (input.asset_id) await evidenceAssets(trx, access.tenantId, [input.asset_id]);
    const row = await trx.insertInto('incident_evidence').values({ tenant_id: access.tenantId, incident_id: id, asset_id: input.asset_id ?? null, note: input.note ?? null, added_by: actor.userId! })
      .returning(['id', 'asset_id', 'note', 'created_at']).executeTakeFirstOrThrow();
    await audit(trx, actor, 'incident.evidence_added', { tenantId: access.tenantId, targetType: 'incident', targetId: id, data: { evidence_id: row.id } });
    return { ...row, url: row.asset_id ? assetUrl(row.asset_id) : null };
  });
}
